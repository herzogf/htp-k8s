package testcluster

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
)

var crdGVR = schema.GroupVersionResource{
	Group:    "apiextensions.k8s.io",
	Version:  "v1",
	Resource: "customresourcedefinitions",
}

// decodeManifest parses a multi-document YAML manifest (documents separated
// by "---", as produced by `kubectl apply -f`-style tooling) into
// unstructured objects, preserving document order.
func decodeManifest(raw []byte) ([]*unstructured.Unstructured, error) {
	dec := utilyaml.NewYAMLOrJSONDecoder(bytes.NewReader(raw), 4096)

	var objs []*unstructured.Unstructured
	for {
		obj := &unstructured.Unstructured{}
		if err := dec.Decode(obj); err != nil {
			if err == io.EOF {
				break
			}
			return nil, fmt.Errorf("decode manifest document: %w", err)
		}
		if len(obj.Object) == 0 {
			continue // blank document between "---" separators
		}
		objs = append(objs, obj)
	}
	return objs, nil
}

// applyManifest creates every object in objs (or updates it if it already
// exists), in a shape good enough for the fixed, small manifest set this
// package applies once per freshly-created cluster. It is not a general
// "kubectl apply" replacement: no 3-way merge, no pruning.
//
// CustomResourceDefinitions are applied first and waited on until
// Established, since later objects in the same manifest (custom resources
// of those CRD-defined kinds) would otherwise race the API server's
// discovery of the new type. The RESTMapper is reset after CRDs establish
// so it picks up the newly-available kinds.
//
// Objects whose kind the cluster's API server doesn't recognize (a
// meta.NoKindMatchError) are skipped with a warning rather than failing the
// whole apply, via tolerateMissingKinds — used for manifest entries (like a
// FlowSchema) that are a nice-to-have on newer clusters but not load-bearing
// for the KWOK controller to function.
func applyManifest(ctx context.Context, dyn dynamic.Interface, mapper meta.ResettableRESTMapper, objs []*unstructured.Unstructured, tolerateMissingKinds bool, warnf func(format string, args ...any)) error {
	var crds, others []*unstructured.Unstructured
	for _, o := range objs {
		if o.GetKind() == "CustomResourceDefinition" {
			crds = append(crds, o)
		} else {
			others = append(others, o)
		}
	}

	for _, o := range crds {
		if err := applyObject(ctx, dyn, mapper, o); err != nil {
			return fmt.Errorf("apply %s %q: %w", o.GetKind(), o.GetName(), err)
		}
	}
	for _, o := range crds {
		if err := waitForCRDEstablished(ctx, dyn, o.GetName()); err != nil {
			return err
		}
	}
	if len(crds) > 0 {
		mapper.Reset()
	}

	for _, o := range others {
		if err := applyObject(ctx, dyn, mapper, o); err != nil {
			if tolerateMissingKinds && meta.IsNoMatchError(err) {
				if warnf != nil {
					warnf("skipping %s %q: %v", o.GetKind(), o.GetName(), err)
				}
				continue
			}
			return fmt.Errorf("apply %s %q: %w", o.GetKind(), o.GetName(), err)
		}
	}
	return nil
}

// applyObject creates obj, or updates it (preserving resourceVersion) if it
// already exists.
func applyObject(ctx context.Context, dyn dynamic.Interface, mapper meta.RESTMapper, obj *unstructured.Unstructured) error {
	gvk := obj.GroupVersionKind()
	mapping, err := mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return err
	}

	var ri dynamic.ResourceInterface
	if mapping.Scope.Name() == meta.RESTScopeNameNamespace {
		ns := obj.GetNamespace()
		if ns == "" {
			ns = "default"
		}
		ri = dyn.Resource(mapping.Resource).Namespace(ns)
	} else {
		ri = dyn.Resource(mapping.Resource)
	}

	_, err = ri.Create(ctx, obj, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := ri.Get(ctx, obj.GetName(), metav1.GetOptions{})
		if getErr != nil {
			return fmt.Errorf("get existing object: %w", getErr)
		}
		obj.SetResourceVersion(existing.GetResourceVersion())
		_, err = ri.Update(ctx, obj, metav1.UpdateOptions{})
	}
	return err
}

// waitForCRDEstablished blocks until the named CustomResourceDefinition
// reports its "Established" condition as True.
func waitForCRDEstablished(ctx context.Context, dyn dynamic.Interface, name string) error {
	return waitForResourceReady(ctx, 500*time.Millisecond, 60*time.Second,
		func(ctx context.Context) (*unstructured.Unstructured, error) {
			return dyn.Resource(crdGVR).Get(ctx, name, metav1.GetOptions{})
		},
		crdIsEstablished,
	)
}

func crdIsEstablished(crd *unstructured.Unstructured) bool {
	conditions, _, _ := unstructured.NestedSlice(crd.Object, "status", "conditions")
	for _, c := range conditions {
		cond, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if cond["type"] == "Established" && cond["status"] == "True" {
			return true
		}
	}
	return false
}
