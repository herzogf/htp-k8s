# htp-k8s

**A cinematic, *Hackers*-(1995)-styled live 3D view of your Kubernetes cluster.** Hack the planet!

![htp-k8s — a 3D city of node towers](docs/images/hero.png)

## What is this?

htp-k8s turns a live Kubernetes cluster into a neon 3D city you can fly through. Each **node** is a glowing tower; each **pod** is a lit panel on its face, coloured by phase and blinking as it works; **lanes** trace the floor between them. Flip between a **Node view** and a **Namespace view**, click any tower or pod for a live **detail popup** with a log tail, or hit **Demo Mode** and let the camera thread a hands-off canyon tour through the skyline.

It's **read-only** — a thing to *watch*, styled after the 1995 film *Hackers*, not another admin dashboard.

## Quickstart

htp-k8s is a single binary (the web UI is embedded) that serves a browser UI against whatever cluster your current kubeconfig points at. There's no authentication anywhere in it (it's a read-only viewer, see below), so **it listens on `127.0.0.1:8080` — loopback only — by default**: reachable from the browser on the same machine, not from anywhere else on the network. To expose it deliberately, pass `-addr :8080` (or set `HTP_K8S_ADDR=:8080`).

**Run the binary** — grab the latest build for your platform from [Releases](https://github.com/herzogf/htp-k8s/releases):

```bash
# Linux amd64 example — see Releases for your platform and the latest version
tar -xzf htp-k8s_0.2.0_linux_amd64.tar.gz
./htp-k8s                     # serves on 127.0.0.1:8080 (loopback only) against your current kubeconfig
# then open http://localhost:8080
```

**Or run the container image:**

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=:8080 \
  -v "$HOME/.kube/config:/kube/config:ro" \
  ghcr.io/herzogf/htp-k8s:v0.2.0
# then open http://localhost:8080
```

The container looks for a kubeconfig at `/kube/config` by default, so mounting your kubeconfig there is all that's needed — no `-e KUBECONFIG` boilerplate. Mounting elsewhere? Override it explicitly: add `-e KUBECONFIG=/some/other/path` and mount to match.

`--user "$(id -u):$(id -g)"` makes the container read that mount as you rather than as its own built-in non-root user: a standard kind/kubectl-written kubeconfig is mode `0600` (owner-read-only), and without this flag the container can't read a file it doesn't own — it fails with `permission denied`, and the resulting error names this exact flag. `$(id -u)` is bash/zsh syntax (Linux, macOS Terminal); PowerShell and cmd.exe have no `id` command, so on Windows drop the flag and try the plain command first. We haven't verified on this project how Docker Desktop's bind-mount layer handles host file permissions on Windows or macOS — if you still hit `permission denied` there, mounting a copy of your kubeconfig with broader read permissions is a fallback that doesn't depend on any of this. From a **root shell**, `$(id -u):$(id -g)` expands to `0:0`, silently turning the container back into root instead of your (non-root) uid — run this from your normal user shell, not as root (`sudo docker run …` is fine: the shell expands `$(id -u)` before `sudo` ever runs).

`-e HTP_K8S_ADDR=:8080` is required here — it's not optional the way it looks. Docker's `-p 127.0.0.1:8080:8080` forwards traffic to the *container's* own interface address, never to its loopback, so a container left on the loopback-only default above would never see that traffic at all. The `-p` host-side binding (loopback) is what actually keeps this off your network, exactly as it does for the bare binary above — the container just has to bind wider *inside its own network namespace* for that forwarding to reach it. (There's no way to bake this into the image instead: ko, which builds it, has no supported way to set a container-*runtime* environment variable through its build config — only a Go *build*-time one, like the version metadata already baked in — verified against the pinned ko and GoReleaser versions while implementing this.)

htp-k8s exits immediately if it can't reach a cluster (if you forget the `-v` mount, the error names the missing `/kube/config` path). The recipe above works as-is for any cluster reachable at a real network address — EKS, GKE, OpenShift, a remote on-prem cluster.

#### Pointing the container at a *local* cluster

A local cluster's kubeconfig usually points at `https://127.0.0.1:<port>` — meaningless from inside a bridge-networked container, which has its own separate loopback distinct from the host's. Two cases:

**Already have a local [kind](https://kind.sigs.k8s.io/) cluster** (perhaps made with the `kind create cluster` example below, or one you already use for other local development)? Point the container at it without touching that cluster, or your normal kubeconfig, at all:

```bash
kind get kubeconfig --internal --name kind > /tmp/htp-k8s-kubeconfig   # "kind" is the default cluster name; use yours if you named it
docker run --rm --network kind -p 127.0.0.1:8080:8080 \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=:8080 \
  -v /tmp/htp-k8s-kubeconfig:/kube/config:ro \
  ghcr.io/herzogf/htp-k8s:v0.2.0
# then open http://localhost:8080
```

`kind get kubeconfig --internal` only *reads* the cluster's existing state — it's a generator, not a mutation. It writes a second, container-only kubeconfig to the file you redirect it to; your `~/.kube/config` and current `kubectl` context are untouched (verified: identical before/after, byte for byte). What differs is the server address inside it: the cluster's in-network hostname (`https://<cluster>-control-plane:6443`) instead of the externally-published `127.0.0.1:<port>` your normal kubeconfig has — `--network kind` (the Docker network `kind create cluster` already made, nothing extra to set up) is what makes that hostname resolve from the container.

**Some other local cluster** — k3d, minikube with the Docker driver, Docker Desktop's built-in Kubernetes — has the same `127.0.0.1`-only problem but no `kind`-style in-network hostname to fall back on. The general fallback is `--network host`, which shares the host's network stack outright, so your normal kubeconfig's `127.0.0.1:<port>` resolves correctly from inside the container:

```bash
docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -e HTP_K8S_ADDR=127.0.0.1:8080 \
  -v "$HOME/.kube/config:/kube/config:ro" \
  ghcr.io/herzogf/htp-k8s:v0.2.0
# then open http://localhost:8080
```

`--network host` has its own catch, and `-e HTP_K8S_ADDR=127.0.0.1:8080` (**not** the `:8080` used above) is how this recipe accounts for it: Docker's `-p` is silently ignored under host networking, so the app must bind loopback *itself*, on the host's own network stack, or it's reachable from every interface on the actual host. (Verified directly: under `--network host`, `-e HTP_K8S_ADDR=127.0.0.1:8080` binds loopback-only exactly like the native binary's own default — reachable at `localhost:8080`, unreachable from elsewhere on the network. Not verified against k3d/minikube/Docker Desktop specifically — none are set up in this project's own test environment — but the recipe follows from how `--network host` and Docker's `-p` interact, which doesn't depend on which tool created the cluster.)

**Just want to try it?** Spin up a throwaway local cluster with [kind](https://kind.sigs.k8s.io/) and run the binary directly — no container networking to think about at all:

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
gh attestation verify htp-k8s_0.2.0_linux_amd64.tar.gz --repo herzogf/htp-k8s

# the container image (the tag resolves to the multi-arch index)
gh attestation verify oci://ghcr.io/herzogf/htp-k8s:v0.2.0 --repo herzogf/htp-k8s
```

A passing check means the artifact was built by this repo's release workflow and hasn't been tampered with since. More on the posture: [ADR-0005](docs/adr/0005-supply-chain-security-posture.md).

## Docs & further reading

- **[Running & developing locally](docs/running-locally.md)** — build from source and stand up a populated multi-tower scene (kind + KWOK).
- For technical background and design decisions, see **[CONTEXT.md](CONTEXT.md)** and the **[ADRs](docs/adr/)**.

## License

[Apache License 2.0](LICENSE).
