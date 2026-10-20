FROM debian:bookworm-slim

# Install pinned GCC/G++ and minimal execution utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    libstdc++-12-dev \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged sandbox user and group
RUN groupadd -g 10001 sandbox && \
    useradd -u 10001 -g sandbox -m -s /bin/sh sandbox

# Prepare workspace directory with strict ownership
RUN mkdir -p /sandbox/workspace && chown -R sandbox:sandbox /sandbox

WORKDIR /sandbox/workspace
USER sandbox:sandbox

# Default command
CMD ["/bin/sh"]
