# htp-k8s

**A cinematic, *Hackers*-(1995)-styled live 3D view of your Kubernetes cluster.** Hack the planet!

![htp-k8s — a 3D city of node towers](docs/images/hero.png)

## What is this?

htp-k8s turns a live Kubernetes cluster into a neon 3D city you can fly through. Each **node** is a glowing tower; each **pod** is a lit panel on its face, coloured by phase and blinking as it works; **lanes** trace the floor between them. Flip between a **Node view** and a **Namespace view**, click any tower or pod for a live **detail popup** with a log tail, or hit **Demo Mode** and let the camera thread a hands-off canyon tour through the skyline.

It's **read-only** — a thing to *watch*, styled after the 1995 film *Hackers*, not another admin dashboard.

## Quickstart

htp-k8s is a single binary (the web UI is embedded) that serves a browser UI against whatever cluster your current kubeconfig points at. It's read-only with no authentication, so it **listens on `127.0.0.1:8080` (loopback only) by default** — see [Running & developing locally](docs/running-locally.md) for why, and how to widen it.

**Run the binary** — grab the latest build for your platform from [Releases](https://github.com/herzogf/htp-k8s/releases):

```bash
# Linux amd64 example — see Releases for your platform and the latest version
tar -xzf htp-k8s_0.3.0_linux_amd64.tar.gz
./htp-k8s                     # serves on 127.0.0.1:8080 (loopback only) against your current kubeconfig
# then open http://localhost:8080
```

**Or run the container image.** It looks for a kubeconfig at `/kube/config`; `--user` is needed because of kubeconfig file permissions (`0600`) — see [Running & developing locally](docs/running-locally.md#the-container-image) if either needs troubleshooting.

Your cluster is at a real network address (EKS, GKE, OpenShift, on-prem):

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=:8080 \
  -v "$HOME/.kube/config:/kube/config:ro" \
  ghcr.io/herzogf/htp-k8s:v0.3.0
# then open http://localhost:8080
```

Already have a local [kind](https://kind.sigs.k8s.io/) cluster:

```bash
kind get kubeconfig --internal --name kind > /tmp/htp-k8s-kubeconfig   # "kind" is the default cluster name; use yours if you named it
docker run --rm --network kind -p 127.0.0.1:8080:8080 \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=:8080 \
  -v /tmp/htp-k8s-kubeconfig:/kube/config:ro \
  ghcr.io/herzogf/htp-k8s:v0.3.0
# then open http://localhost:8080
```

Some other local cluster (k3d, minikube, Docker Desktop):

```bash
# NOTE: HTP_K8S_ADDR is 127.0.0.1:8080 here, not the bare :8080 above —
# --network host makes `-p` a no-op, so the app must bind loopback itself.
docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=127.0.0.1:8080 \
  -v "$HOME/.kube/config:/kube/config:ro" \
  ghcr.io/herzogf/htp-k8s:v0.3.0
# then open http://localhost:8080
```

**Just want to try it?** Spin up a throwaway local cluster with [kind](https://kind.sigs.k8s.io/) and run the binary directly:

```bash
kind create cluster        # htp-k8s shows this single node as one lone tower
./htp-k8s
```

For a *populated* multi-tower scene (artificial [KWOK](https://kwok.sigs.k8s.io/) load) and for building from source, see **[Running & developing locally](docs/running-locally.md)**.

## Cluster support

Runs on **vanilla Kubernetes**. **OpenShift** support is planned but **not yet tested** — htp-k8s degrades gracefully when a cluster capability isn't available, but the OpenShift-specific paths haven't been validated yet.

## See it

![Detail popup on a pod, with a live log tail](docs/images/detail-popup.png)

*Detail popups — live detail and a log tail on any pod or node.*

![The floor lanes running between the towers](docs/images/floor-lanes.png)

*Floor lanes — the *Hackers* wiring running between the towers.*

![Demo Mode: a hands-off camera tour threading the canyon between towers](docs/images/demo-canyon-tour.gif)

*Demo Mode threads a hands-off cinematic tour through the canyon between the towers.*

## Controls

- **Fly:** click the canvas to grab the pointer, then `WASD` (or the arrow keys) to fly, `Space`/`Shift` to rise/descend, and the mouse to look around. `Esc` releases the pointer again.
- **Inspect:** with the pointer released, click any tower or pod panel to fly the camera to it and open its detail popup; `Esc`, its close button, or a click on empty space dismisses it.
- **Demo Mode:** click the **Demo Mode** toggle (top right) to start the hands-off canyon tour; manual flight resumes as soon as you switch it back off.
- **Quit:** close the tab, then `Ctrl-C` the binary/container.

The full control scheme is in [Running & developing locally](docs/running-locally.md#controls).

## Supply chain

Every release is built in CI with **keyless, Sigstore-backed attestations** — build provenance for the binaries and the container image, plus a CycloneDX **SBOM** per artifact — and is **CVE-scanned** with Trivy. There are no keys to manage; verify what you downloaded with the [GitHub CLI (`gh`)](https://cli.github.com/):

```bash
# the release binary you downloaded
gh attestation verify htp-k8s_0.3.0_linux_amd64.tar.gz \
  --repo herzogf/htp-k8s \
  --signer-workflow herzogf/htp-k8s/.github/workflows/release.yml

# the container image (the tag resolves to the multi-arch index)
gh attestation verify oci://ghcr.io/herzogf/htp-k8s:v0.3.0 \
  --repo herzogf/htp-k8s \
  --signer-workflow herzogf/htp-k8s/.github/workflows/release.yml
```

A passing check means the artifact was built by this repo's release workflow and hasn't been tampered with since. Both commands print the resolved digest — pin `@sha256:…` instead of the tag if you need that guarantee to hold even if the tag were ever repointed. More on the posture: [ADR-0005](docs/adr/0005-supply-chain-security-posture.md).

Stable releases also publish moving tags (`latest`, `X`, `X.Y`) as a **pull convenience, not a verification target** — the digest-pinning note above applies doubly here. Resolve, then verify that:

```bash
docker pull ghcr.io/herzogf/htp-k8s:latest   # prints "Digest: sha256:…"

gh attestation verify oci://ghcr.io/herzogf/htp-k8s@sha256:<digest-from-above> \
  --repo herzogf/htp-k8s \
  --signer-workflow herzogf/htp-k8s/.github/workflows/release.yml
```

## Docs & further reading

- **[Running & developing locally](docs/running-locally.md)** — build from source and stand up a populated multi-tower scene (kind + KWOK).
- For technical background and design decisions, see **[CONTEXT.md](CONTEXT.md)** and the **[ADRs](docs/adr/)**.

## License

[Apache License 2.0](LICENSE).
