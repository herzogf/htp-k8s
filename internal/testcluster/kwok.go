package testcluster

import (
	"context"
	_ "embed"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes"
)

//go:embed manifests/kwok.yaml
var kwokControllerManifest []byte

//go:embed manifests/stage-fast.yaml
var kwokFastStagesManifest []byte

const (
	// defaultKWOKImage is pinned to the KWOK release whose manifests are
	// embedded in manifests/kwok.yaml and manifests/stage-fast.yaml. Bump
	// all three together.
	defaultKWOKImage = "registry.k8s.io/kwok/kwok:v0.8.0"

	kwokNamespace      = "kube-system"
	kwokDeploymentName = "kwok-controller"

	// fakeNamespace is where AddFakePods creates its Pod objects.
	fakeNamespace = "default"

	// fakeNodeAnnotation and fakeNodeAnnotationValue mark a Node as
	// KWOK-simulated. The controller is configured (see
	// patchKWOKControllerDeployment) to manage only Nodes carrying this
	// annotation, so it never takes over lifecycle management of the kind
	// cluster's one real node — the whole point of ADR-0004's two-tier
	// strategy is that the real node stays real.
	fakeNodeAnnotation      = "kwok.x-k8s.io/node"
	fakeNodeAnnotationValue = "fake"
)

// installKWOK deploys the KWOK controller (CRDs, RBAC, ConfigMap, Service,
// Deployment) into the cluster's kube-system namespace, waits for it to
// become available, then installs the "fast" Stage definitions that make
// simulated Node/Pod lifecycle transitions near-instant.
func (c *Cluster) installKWOK(ctx context.Context, image string, warnf func(format string, args ...any)) error {
	if image == "" {
		image = defaultKWOKImage
	}

	objs, err := decodeManifest(kwokControllerManifest)
	if err != nil {
		return fmt.Errorf("decode kwok controller manifest: %w", err)
	}
	if err := patchKWOKControllerDeployment(objs, image); err != nil {
		return err
	}
	if err := applyManifest(ctx, c.dynamicClient, c.mapper, objs, true, warnf); err != nil {
		return fmt.Errorf("apply kwok controller manifest: %w", err)
	}

	if err := waitForDeploymentAvailable(ctx, c.Clientset, kwokNamespace, kwokDeploymentName, 3*time.Minute); err != nil {
		return fmt.Errorf("wait for kwok-controller deployment to become available: %w", err)
	}

	stageObjs, err := decodeManifest(kwokFastStagesManifest)
	if err != nil {
		return fmt.Errorf("decode kwok fast-stage manifest: %w", err)
	}
	if err := applyManifest(ctx, c.dynamicClient, c.mapper, stageObjs, false, warnf); err != nil {
		return fmt.Errorf("apply kwok fast-stage manifest: %w", err)
	}
	return nil
}

// patchKWOKControllerDeployment mutates the embedded manifest's Deployment
// in place so the running controller:
//   - only manages Nodes annotated fakeNodeAnnotation=fakeNodeAnnotationValue
//     (never the real kind node — the manifest's own default is to manage
//     *all* nodes, which would fight the real kubelet on the real node)
//   - uses the given image, if the caller overrode it
func patchKWOKControllerDeployment(objs []*unstructured.Unstructured, image string) error {
	for _, o := range objs {
		if o.GetKind() != "Deployment" || o.GetName() != kwokDeploymentName {
			continue
		}

		containers, found, err := unstructured.NestedSlice(o.Object, "spec", "template", "spec", "containers")
		if err != nil || !found || len(containers) == 0 {
			return fmt.Errorf("kwok controller manifest: Deployment %q has no spec.template.spec.containers", kwokDeploymentName)
		}
		container, ok := containers[0].(map[string]any)
		if !ok {
			return fmt.Errorf("kwok controller manifest: Deployment %q has a malformed container entry", kwokDeploymentName)
		}

		args, _, _ := unstructured.NestedStringSlice(container, "args")
		args = append(args,
			"--manage-all-nodes=false",
			"--manage-nodes-with-annotation-selector="+fakeNodeAnnotation+"="+fakeNodeAnnotationValue,
		)
		if err := unstructured.SetNestedStringSlice(container, args, "args"); err != nil {
			return fmt.Errorf("set kwok-controller args: %w", err)
		}

		if image != "" {
			if err := unstructured.SetNestedField(container, image, "image"); err != nil {
				return fmt.Errorf("set kwok-controller image: %w", err)
			}
		}

		containers[0] = container
		if err := unstructured.SetNestedSlice(o.Object, containers, "spec", "template", "spec", "containers"); err != nil {
			return fmt.Errorf("write back kwok-controller containers: %w", err)
		}
		return nil
	}
	return fmt.Errorf("kwok controller manifest: no Deployment named %q found", kwokDeploymentName)
}

func waitForDeploymentAvailable(ctx context.Context, clientset kubernetes.Interface, namespace, name string, timeout time.Duration) error {
	return waitForResourceReady(ctx, 2*time.Second, timeout,
		func(ctx context.Context) (*appsv1.Deployment, error) {
			return clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		},
		func(dep *appsv1.Deployment) bool { return dep.Status.AvailableReplicas >= 1 },
	)
}

// AddFakeNodes creates count KWOK-simulated Node objects and waits for each
// to report Ready. It returns the created node names, suitable as the
// nodeNames argument to AddFakePods.
//
// This is the "modest, configurable number of KWOK-simulated nodes"
// capability from ADR-0004's PR-scale tier (5-10 nodes); callers decide the
// count.
func (c *Cluster) AddFakeNodes(ctx context.Context, count int) ([]string, error) {
	if count <= 0 {
		return nil, fmt.Errorf("testcluster: AddFakeNodes count must be positive, got %d", count)
	}

	names := make([]string, 0, count)
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("%s-fake-node-%d", c.Name, i)
		if _, err := c.Clientset.CoreV1().Nodes().Create(ctx, fakeNode(name), metav1.CreateOptions{}); err != nil {
			return names, fmt.Errorf("testcluster: create fake node %q: %w", name, err)
		}
		names = append(names, name)
	}

	for _, name := range names {
		if err := waitForNodeReady(ctx, c.Clientset, name, 60*time.Second); err != nil {
			return names, fmt.Errorf("testcluster: wait for fake node %q ready: %w", name, err)
		}
	}
	return names, nil
}

// AddFakePods creates count KWOK-simulated Pod objects, round-robin bound
// (via spec.nodeName, bypassing the scheduler entirely — standard practice
// for KWOK-simulated workloads) across nodeNames, and waits for each to
// report Running. nodeNames is typically the slice returned by a prior
// AddFakeNodes call.
func (c *Cluster) AddFakePods(ctx context.Context, nodeNames []string, count int) ([]string, error) {
	if count <= 0 {
		return nil, fmt.Errorf("testcluster: AddFakePods count must be positive, got %d", count)
	}
	if len(nodeNames) == 0 {
		return nil, fmt.Errorf("testcluster: AddFakePods requires at least one node name")
	}

	names := make([]string, 0, count)
	for i := 0; i < count; i++ {
		nodeName := nodeNames[i%len(nodeNames)]
		name := fmt.Sprintf("%s-fake-pod-%d", c.Name, i)
		if _, err := c.Clientset.CoreV1().Pods(fakeNamespace).Create(ctx, fakePod(name, nodeName), metav1.CreateOptions{}); err != nil {
			return names, fmt.Errorf("testcluster: create fake pod %q: %w", name, err)
		}
		names = append(names, name)
	}

	for _, name := range names {
		if err := waitForPodRunning(ctx, c.Clientset, fakeNamespace, name, 60*time.Second); err != nil {
			return names, fmt.Errorf("testcluster: wait for fake pod %q running: %w", name, err)
		}
	}
	return names, nil
}

func fakeNode(name string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Annotations: map[string]string{
				fakeNodeAnnotation:             fakeNodeAnnotationValue,
				"node.alpha.kubernetes.io/ttl": "0",
			},
			Labels: map[string]string{
				"kubernetes.io/hostname": name,
				"kubernetes.io/os":       "linux",
				"kubernetes.io/arch":     "amd64",
				"type":                   "kwok",
			},
		},
		Spec: corev1.NodeSpec{
			Taints: []corev1.Taint{
				{
					Key:    fakeNodeAnnotation,
					Value:  fakeNodeAnnotationValue,
					Effect: corev1.TaintEffectNoSchedule,
				},
			},
		},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("32"),
				corev1.ResourceMemory: resource.MustParse("256Gi"),
				corev1.ResourcePods:   resource.MustParse("110"),
			},
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("32"),
				corev1.ResourceMemory: resource.MustParse("256Gi"),
				corev1.ResourcePods:   resource.MustParse("110"),
			},
			NodeInfo: corev1.NodeSystemInfo{
				Architecture:    "amd64",
				OperatingSystem: "linux",
			},
		},
	}
}

func fakePod(name, nodeName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: fakeNamespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "htp-k8s-testcluster",
			},
		},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Tolerations: []corev1.Toleration{
				{
					Key:      fakeNodeAnnotation,
					Operator: corev1.TolerationOpEqual,
					Value:    fakeNodeAnnotationValue,
					Effect:   corev1.TaintEffectNoSchedule,
				},
			},
			Containers: []corev1.Container{
				{
					Name:  "fake",
					Image: "registry.k8s.io/pause:3.10",
				},
			},
		},
	}
}

func waitForNodeReady(ctx context.Context, clientset kubernetes.Interface, name string, timeout time.Duration) error {
	return waitForResourceReady(ctx, 500*time.Millisecond, timeout,
		func(ctx context.Context) (*corev1.Node, error) {
			return clientset.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
		},
		nodeIsReady,
	)
}

func nodeIsReady(node *corev1.Node) bool {
	for _, cond := range node.Status.Conditions {
		if cond.Type == corev1.NodeReady {
			return cond.Status == corev1.ConditionTrue
		}
	}
	return false
}

func waitForPodRunning(ctx context.Context, clientset kubernetes.Interface, namespace, name string, timeout time.Duration) error {
	return waitForResourceReady(ctx, 500*time.Millisecond, timeout,
		func(ctx context.Context) (*corev1.Pod, error) {
			return clientset.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		},
		func(pod *corev1.Pod) bool { return pod.Status.Phase == corev1.PodRunning },
	)
}
