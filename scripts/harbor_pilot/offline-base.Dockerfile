# Native arm64 offline fallback for a Docker Desktop daemon whose registry
# proxy is unavailable. Build context must contain expanded official runtimes:
#   node/                Node 22.17.0 linux-arm64
#   python/              CPython 3.12.11 linux-aarch64
#   gate-d/node_modules/ npm-installed with --os=linux --cpu=arm64
FROM hugin/ubuntu-base:22.04.5-arm64

USER root
COPY node/ /usr/local/
COPY python/ /opt/python/
COPY gate-d/node_modules/ /opt/gate-d/node_modules/
ENV PATH="/opt/gate-d/node_modules/.bin:/opt/python/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV LANG="C.UTF-8"

RUN node --version \
    && npm --version \
    && tsc --version \
    && tsx --version \
    && test -f /opt/gate-d/node_modules/@types/node/package.json \
    && python3 --version \
    && bash --version \
    && diff --version \
    && grep --version

WORKDIR /app
