FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 libgtk-3-0t64 libwebkit2gtk-4.1-0 \
    libmspack0 libopengl0 libsecret-1-0 libglu1-mesa xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
ARG ORCA_VERSION=2.5.0
ARG ORCA_SHA256=d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c
RUN curl -fL --retry 3 "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage" -o /tmp/orca.AppImage \
    && echo "${ORCA_SHA256}  /tmp/orca.AppImage" | sha256sum -c - \
    && chmod +x /tmp/orca.AppImage && cd /opt && /tmp/orca.AppImage --appimage-extract >/dev/null \
    && mv squashfs-root orca && chmod -R a+rX /opt/orca && rm /tmp/orca.AppImage
RUN useradd --uid 10001 --create-home slicer && mkdir /data && chown slicer:slicer /data
WORKDIR /app
COPY . /app
RUN chmod -R a+rX /app
USER 10001:10001
ENV HOME=/tmp/home OMP_NUM_THREADS=2
EXPOSE 8080
CMD ["python3", "server.py"]
