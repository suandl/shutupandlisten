# Baking Swift into the base image (the durable fix — "B")

The userspace install is now automated: `.devcontainer/post-create-project.sh`
is invoked by the base image's `post-create.sh` (Step 13) on every container
create/rebuild, and installs Swift into `$HOME` (re-extracting from a
workspace-cached tarball, so no re-download). That is enough to run the tests.

Baking Swift into the base image is the further, optional improvement:

- Image: `ghcr.io/zookanalytics/bmad-orchestrator/devcontainer` (a **different
  repo** — this change is made there, not here).
- Once done, every agent container has `swift` on `PATH` at build time, with
  **no per-create extraction, no download, and no firewall entry** —
  `ShutUpAndListenKit` has zero external SwiftPM deps, so `swift test` is fully
  offline. The project hook then becomes a no-op fallback.

## Why the image is nicer than the project hook

The project hook (`post-create-project.sh`) works, but pays a cost on every
container create: extract ~3 GB from the cached tarball (seconds), or a ~1 GB
download on a cold cache. It also keeps a 1 GB tarball in the workspace
(`.devcontainer/.swift-cache/`, gitignored). Baking the toolchain into the
image amortizes all of that into one cached image layer, shared by every repo
that uses the base image — not just this one.

## Dockerfile snippet (Debian base, arm64 + amd64)

swift.org publishes `debian12` builds; they run on Debian 13/trixie via glibc
forward-compat (verified in-container). Key the download off `TARGETARCH`:

```dockerfile
# --- Swift toolchain -------------------------------------------------------
ARG SWIFT_VERSION=6.3.3
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) SWIFT_PLATFORM=debian12-aarch64 ;; \
      amd64) SWIFT_PLATFORM=debian12         ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    # Runtime libs Swift links against (libpython3 only needed for the LLDB REPL):
    apt-get update; \
    apt-get install -y --no-install-recommends \
      binutils libcurl4 libxml2 libncursesw6 libz-dev libedit2 libsqlite3-0 \
      libc6-dev libgcc-s1 libstdc++6 tzdata zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*; \
    url="https://download.swift.org/swift-${SWIFT_VERSION}-release/${SWIFT_PLATFORM}/swift-${SWIFT_VERSION}-RELEASE/swift-${SWIFT_VERSION}-RELEASE-${SWIFT_PLATFORM}.tar.gz"; \
    curl -fSL --retry 3 "$url" -o /tmp/swift.tar.gz; \
    mkdir -p /usr/local/swift; \
    tar -xzf /tmp/swift.tar.gz -C /usr/local/swift --strip-components=1; \
    rm /tmp/swift.tar.gz; \
    ln -s /usr/local/swift/usr/bin/swift  /usr/local/bin/swift; \
    ln -s /usr/local/swift/usr/bin/swiftc /usr/local/bin/swiftc
RUN swift --version
```

Alternative source (no download in the build): `COPY --from=swiftlang/swift:6.3.3`
the `/usr/lib/swift` + `/usr/bin/swift*` layers. Simpler layer caching, but ties
you to the swiftlang image layout.

## After it ships

1. Rebuild + publish the base image; bump the tag the running container pulls.
2. In this repo, `.devcontainer/post-create-project.sh` becomes a no-op (its
   version check sees the baked-in toolchain and exits early) — keep it as a
   fallback for older base images, or delete it and drop the
   `.swift-cache/` gitignore entry.
3. The `swift.org` entries in `.devcontainer/allowed-domains.txt` are then only
   needed if you ever install a *different* toolchain at runtime; otherwise they
   can be dropped.

## To hand this off

The base image is in `zookanalytics/bmad-orchestrator`. Point me at that repo
(or check it out) and I will open a PR wiring in the snippet above and a CI job
that runs `swift test` against `ios/ShutUpAndListenKit`.
