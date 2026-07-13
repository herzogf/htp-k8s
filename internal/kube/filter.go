package kube

import (
	"context"
	"fmt"
	"log"
	"path"
	"strings"

	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/herzogf/htp-k8s/internal/scene"
)

// NamespaceFilter decides which Namespaces/Projects are included in the scene
// (see CONTEXT.md's Namespace Filter). It has two modes — a default
// name-pattern match with shell-style wildcards (e.g. "openshift-*") and an
// advanced label selector — plus a zero value that admits everything, so a
// scene with no filter configured hides nothing (nothing is excluded by
// default). The filter is a value type built once at startup (from a CLI flag,
// see cmd/htp-k8s) and threaded unchanged into every scene rebuild, so the same
// preset applies to the initial snapshot and to every Scene Delta.
//
// How it scopes the scene depends on the active View Mode, but the rule is one
// idea — "which Namespaces/Projects are in the scene":
//
//   - Namespace-mode: a Tower is a Namespace/Project, so the filter selects the
//     set of Towers (and, since each Panel sits on its namespace's Tower, the
//     Panels go with them). See BuildTowers.
//   - Node-mode: a Tower is a Node, which is never namespace-scoped, so every
//     Node Tower stays; the filter instead scopes which pods' Panels appear —
//     only pods in an admitted Namespace/Project keep their Panel. See
//     BuildScene's panel predicate. This keeps the filter's meaning consistent
//     across both modes: it is always "these namespaces are in the scene".
type NamespaceFilter struct {
	kind     filterKind
	pattern  string          // filterName: the shell-style glob to match names against.
	selector labels.Selector // filterLabel: the parsed label selector.
}

// filterKind is which of NamespaceFilter's mutually exclusive modes is active.
type filterKind int

const (
	// filterNone is the zero value: no filter, every Namespace/Project admitted.
	filterNone filterKind = iota
	// filterName matches a Namespace/Project by name against a wildcard pattern.
	filterName
	// filterLabel matches a Namespace/Project by its labels against a selector.
	filterLabel
)

// NameFilter builds a name-pattern NamespaceFilter (the default mode): it
// admits a Namespace/Project whose name matches pattern, a shell-style glob
// interpreted by path.Match — "*" and "?" wildcards and "[…]" character classes
// (e.g. "openshift-*"). An empty pattern yields the no-filter zero value
// (admits everything). A malformed pattern is rejected here so a bad CLI flag
// fails loudly at startup rather than silently matching nothing.
func NameFilter(pattern string) (NamespaceFilter, error) {
	if pattern == "" {
		return NamespaceFilter{}, nil
	}
	// path.Match reports ErrBadPattern only once it scans as far as the
	// malformed syntax, so match against a non-empty sample to force it through
	// the whole pattern (matching against "" can short-circuit early).
	if _, err := path.Match(pattern, "x"); err != nil {
		return NamespaceFilter{}, fmt.Errorf("invalid namespace name pattern %q: %w", pattern, err)
	}
	return NamespaceFilter{kind: filterName, pattern: pattern}, nil
}

// LabelFilter builds an advanced label-selector NamespaceFilter: it admits a
// Namespace/Project whose labels satisfy selector, parsed with Kubernetes' own
// labels.Parse — the same syntax as kubectl's -l flag (e.g.
// "team=platform,tier!=infra"). An empty selector yields the no-filter zero
// value. A malformed selector is rejected here so a bad CLI flag fails at
// startup.
func LabelFilter(selector string) (NamespaceFilter, error) {
	if strings.TrimSpace(selector) == "" {
		return NamespaceFilter{}, nil
	}
	sel, err := labels.Parse(selector)
	if err != nil {
		return NamespaceFilter{}, fmt.Errorf("invalid namespace label selector %q: %w", selector, err)
	}
	return NamespaceFilter{kind: filterLabel, selector: sel}, nil
}

// Active reports whether the filter restricts anything. The zero value is
// inactive — it admits every Namespace/Project — so callers can cheaply skip
// all filter work (and, for label mode, an extra cluster LIST) when no filter
// is configured.
func (f NamespaceFilter) Active() bool { return f.kind != filterNone }

// admits reports whether a Namespace/Project with the given name and labels is
// included by the filter. The no-filter zero value admits everything; name mode
// consults only the name (labels ignored); label mode consults only the labels
// (name ignored). It is a pure function — the seam the fake-clientset tests
// exercise — used directly wherever the caller already holds the object's
// labels (BuildTowers' Namespace/Project list).
func (f NamespaceFilter) admits(name string, lbls labels.Set) bool {
	switch f.kind {
	case filterName:
		// The pattern was validated in NameFilter, so a match error is not
		// possible here; ignore it defensively (an unmatched name is excluded).
		ok, _ := path.Match(f.pattern, name)
		return ok
	case filterLabel:
		return f.selector.Matches(lbls)
	default:
		return true
	}
}

// podNamespacePredicate resolves the filter to a predicate over a pod's
// namespace name, deciding which pods keep a Panel. It exists because a Pod
// carries only its namespace *name*, not that namespace's labels, so label mode
// cannot be evaluated from the pod alone — it must first learn which namespace
// names carry matching labels.
//
// It is only meaningful in Node-mode: there a Tower is a Node (never hidden by
// the filter), so this predicate is the sole thing that scopes pods to the
// admitted namespaces. In Namespace-mode a pod's Tower *is* its namespace, so
// filtering the Towers (BuildTowers) already drops pods in hidden namespaces
// via AttachPanels; a nil "admit everything" predicate is returned there so no
// redundant work — and, crucially, no extra namespace LIST for label mode — is
// done.
//
// A nil result means "admit every pod" (the no-filter fast path and the whole
// Namespace-mode path). name and no-filter modes need no cluster read; label
// mode lists Namespaces/Projects once to learn the matching names. If that
// listing fails the filter fails open — admitting all pods, logged — so a
// filter-resolution RBAC gap degrades to "nothing hidden" rather than blanking
// the scene (ADR-0002).
func (f NamespaceFilter) podNamespacePredicate(ctx context.Context, client kubernetes.Interface, dyn dynamic.Interface, mode scene.ViewMode) func(string) bool {
	if !f.Active() || mode != scene.ViewModeNode {
		return nil
	}

	switch f.kind {
	case filterName:
		// Pure name match, evaluated directly on each pod's namespace name —
		// no cluster read needed to know which names a glob admits.
		return func(namespace string) bool { return f.admits(namespace, nil) }
	case filterLabel:
		// Label mode needs each namespace's labels, which pods don't carry, so
		// resolve the admitted names from the shared Namespace/Project source
		// (the same one that filters the Namespace-mode Towers, so both agree).
		names, err := admittedNamespaceNames(ctx, client, dyn, f)
		if err != nil {
			log.Printf("namespace label filter: %v; admitting all namespaces", err)
			return nil
		}
		admitted := nameSet(names)
		return func(namespace string) bool {
			_, ok := admitted[namespace]
			return ok
		}
	default:
		return nil
	}
}

// nameSet collects names into a set for O(1) membership tests.
func nameSet(names []string) map[string]struct{} {
	set := make(map[string]struct{}, len(names))
	for _, n := range names {
		set[n] = struct{}{}
	}
	return set
}
