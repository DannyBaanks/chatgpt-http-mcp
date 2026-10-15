FROM oven/bun:1.4.2-alpine

USER root

RUN apk add --no-cache \
    bash \
    build-base \
    ca-certificates \
    cmake \
    coreutils \
    curl \
    ffmpeg \
    findutils \
    git \
    jq \
    nodejs \
    npm \
    openssh-client \
    python3 \
    py3-pip \
    tar \
    unzip \
    zip \
    && addgroup -S -g 10001 isymcp \
    && adduser -S -D -u 10001 -G isymcp isymcp \
    && mkdir -p /opt/isymcp/src /workspace /home/isymcp \
    && chown -R 10001:10001 /home/isymcp

ENV HOME=/home/isymcp
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT []
