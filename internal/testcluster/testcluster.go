// Package testcluster is a reusable Go test helper that stands up the
// real-kind-cluster-plus-KWOK-controller test harness decided in
// ADR-0004 (docs/adr/0004-two-tier-test-cluster-strategy.md): a real,
// single-node kind cluster (created programmatically via kind's Go
// library — no manually-installed kind CLI, no pre-existing cluster,
// Docker is the only prerequisite) with a KWOK controller attached to it,
// so tests can add simulated Node/Pod objects on top of the one real node
// without the memory cost of many real kind nodes.
//
// Typical use:
//
//	func TestSomething(t *testing.T) {
//		c := testcluster.New(t, testcluster.Options{})
//		// c.Clientset is ready to use; the cluster (and the KWOK
//		// controller on it) is torn down automatically via t.Cleanup,
//		// even if this test fails or panics.
//		nodes, err := c.AddFakeNodes(context.Background(), 5)
//		...
//	}
package testcluster

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"path/filepath"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/kind/pkg/cluster"
)

// Options configures a Cluster created by New. The zero value is valid and
// uses sensible defaults for every field.
type Options struct {
	// KindNodeImage pins the kind node image (e.g.
	// "kindest/node:v1.34.0"). Empty uses kind's own built-in default for
	// the kind version this package is built against.
	KindNodeImage string

	// KWOKImage overrides the KWOK controller container image. Empty uses
	// defaultKWOKImage, matching the version of the embedded manifests.
	KWOKImage string

	// Timeout bounds each of the two slow phases separately (image pulls
	// included): kind cluster creation, and KWOK controller setup. They run
	// sequentially and each gets its own fresh budget, so a slow cold image
	// pull during creation doesn't eat into the KWOK setup deadline. Zero
	// uses a 5 minute default.
	Timeout time.Duration
}

func (o Options) withDefaults() Options {
	if o.Timeout <= 0 {
		o.Timeout = 5 * time.Minute
	}
	return o
}

// Cluster is a running single-node kind cluster with a KWOK controller
// attached.
type Cluster struct {
	// Name is the kind cluster's name, also used as a name prefix for
	// objects created by AddFakeNodes and AddFakePods.
	Name string
	// RESTConfig talks to the cluster's API server.
	RESTConfig *rest.Config
	// Clientset is a typed client for the cluster's API server.
	Clientset kubernetes.Interface

	dynamicClient dynamic.Interface
	mapper        meta.ResettableRESTMapper

	kubeconfigPath string
	provider       *cluster.Provider
	logger         *tLogger

	closeOnce sync.Once
}

// New creates a fresh single-node kind cluster and attaches a KWOK
// controller to it, per ADR-0004. It fails t (via t.Fatalf) if any setup
// step errors.
//
// The cluster is always torn down via t.Cleanup — including when the test
// using it fails or panics — so callers don't need their own defer/cleanup
// for it. Close is exported for tests that want to free resources earlier.
func New(t testing.TB, opts Options) *Cluster {
	t.Helper()
	opts = opts.withDefaults()

	logger := newTLogger(t)
	provider := cluster.NewProvider(
		cluster.ProviderWithDocker(),
		cluster.ProviderWithLogger(logger),
	)

	c := &Cluster{
		Name:     randomClusterName(t),
		provider: provider,
		logger:   logger,
	}

	// Registered before Create so a cluster is torn down even if Create
	// itself fails partway through (kind can leave a container/network
	// behind on a failed or timed-out create), and regardless of whether
	// the test that called New later fails or panics.
	t.Cleanup(c.Close)

	c.kubeconfigPath = filepath.Join(t.TempDir(), "kubeconfig")

	createOpts := []cluster.CreateOption{
		cluster.CreateWithKubeconfigPath(c.kubeconfigPath),
		cluster.CreateWithWaitForReady(opts.Timeout),
		cluster.CreateWithDisplayUsage(false),
		cluster.CreateWithDisplaySalutation(false),
	}
	if opts.KindNodeImage != "" {
		createOpts = append(createOpts, cluster.CreateWithNodeImage(opts.KindNodeImage))
	}

	if err := provider.Create(c.Name, createOpts...); err != nil {
		t.Fatalf("testcluster: create kind cluster: %v", err)
	}

	restConfig, err := clientcmd.BuildConfigFromFlags("", c.kubeconfigPath)
	if err != nil {
		t.Fatalf("testcluster: build rest config from kubeconfig: %v", err)
	}
	c.RESTConfig = restConfig

	clientset, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		t.Fatalf("testcluster: build clientset: %v", err)
	}
	c.Clientset = clientset

	dynClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		t.Fatalf("testcluster: build dynamic client: %v", err)
	}
	c.dynamicClient = dynClient

	discoveryClient, err := discovery.NewDiscoveryClientForConfig(restConfig)
	if err != nil {
		t.Fatalf("testcluster: build discovery client: %v", err)
	}
	c.mapper = restmapper.NewDeferredDiscoveryRESTMapper(memory.NewMemCacheClient(discoveryClient))

	// The KWOK setup phase gets its own fresh budget, independent of however
	// long cluster creation just took (see Options.Timeout).
	ctx, cancel := context.WithTimeout(context.Background(), opts.Timeout)
	defer cancel()

	if err := waitForAnyNodeReady(ctx, clientset, 2*time.Minute); err != nil {
		t.Fatalf("testcluster: wait for real node ready: %v", err)
	}

	warnf := func(format string, args ...any) {
		t.Helper()
		t.Logf("testcluster: "+format, args...)
	}
	if err := c.installKWOK(ctx, opts.KWOKImage, warnf); err != nil {
		t.Fatalf("testcluster: install kwok controller: %v", err)
	}

	return c
}

// Close tears down the cluster immediately, rather than waiting for the
// test to finish. New already registers this via t.Cleanup, so most
// callers never need to call it directly; it's exported for tests that
// want to free resources earlier (e.g. before creating a second Cluster in
// the same test). Idempotent and safe to call multiple times or on a
// partially-initialized Cluster.
func (c *Cluster) Close() {
	c.closeOnce.Do(func() {
		if c.provider != nil {
			if err := c.provider.Delete(c.Name, c.kubeconfigPath); err != nil {
				// Best-effort: e.g. Create may have failed before
				// anything was actually provisioned. Surface it via the
				// logger rather than failing cleanup outright.
				if c.logger != nil {
					c.logger.Warnf("delete kind cluster %q: %v", c.Name, err)
				}
			}
		}
		if c.logger != nil {
			c.logger.close()
		}
	})
}

func randomClusterName(t testing.TB) string {
	t.Helper()
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("testcluster: generate random cluster name: %v", err)
	}
	return "htpk8s-" + hex.EncodeToString(buf)
}

func waitForAnyNodeReady(ctx context.Context, clientset kubernetes.Interface, timeout time.Duration) error {
	return wait.PollUntilContextTimeout(ctx, 1*time.Second, timeout, true, func(ctx context.Context) (bool, error) {
		nodes, err := clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return false, err
		}
		for i := range nodes.Items {
			if nodeIsReady(&nodes.Items[i]) {
				return true, nil
			}
		}
		return false, nil
	})
}

// waitForResourceReady polls get until the fetched object satisfies ready. A
// NotFound is treated as "not created yet, keep waiting" rather than an
// error, since callers often create an object and immediately wait on it. It
// returns nil once ready is satisfied, or an error if ctx/timeout expire
// first or get returns any non-NotFound error.
//
// This collapses the otherwise-identical get+NotFound+predicate polling
// boilerplate shared by the single-object waiters (fake node Ready, fake pod
// Running, kwok-controller Deployment available, CRD Established).
func waitForResourceReady[T any](ctx context.Context, interval, timeout time.Duration, get func(context.Context) (T, error), ready func(T) bool) error {
	return wait.PollUntilContextTimeout(ctx, interval, timeout, true, func(ctx context.Context) (bool, error) {
		obj, err := get(ctx)
		if err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		return ready(obj), nil
	})
}
