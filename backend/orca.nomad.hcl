job "orca-job-api" {
  datacenters = ["homelab"]
  type = "service"
  constraint {
    attribute = "${attr.unique.network.ip-address}"
    value = "192.168.0.230"
  }
  group "api" {
    count = 1
    update {
      max_parallel = 1
      min_healthy_time = "5s"
      healthy_deadline = "2m"
      auto_revert = true
    }
    network {
      mode = "bridge"
      port "http" { to = 8080 }
    }
    restart {
      attempts = 3
      interval = "5m"
      delay = "5s"
      mode = "delay"
    }
    task "native" {
      driver = "docker"
      user = "10001:10001"
      kill_timeout = "10s"
      config {
        image = "orca-job-api:2.5.0-r1"
        force_pull = false
        network_mode = "none"
        init = true
        readonly_rootfs = true
        cap_drop = ["ALL"]
        security_opt = ["no-new-privileges:true"]
        pids_limit = 128
        mount {
          type = "tmpfs"
          target = "/tmp"
          tmpfs_options { size = 268435456 }
        }
        volumes = [
          "/opt/orca-job-api/data:/data",
          "/etc/orca-job-api/api-key:/run/secrets/api-key:ro"
        ]
      }
      resources {
        cpu = 100
        memory = 2048
      }
    }
    task "gateway" {
      driver = "docker"
      user = "101:101"
      config {
        image = "nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236"
        ports = ["http"]
        command = "nginx"
        args = ["-g", "daemon off;"]
        init = true
        readonly_rootfs = true
        cap_drop = ["ALL"]
        security_opt = ["no-new-privileges:true"]
        pids_limit = 32
        mount {
          type = "tmpfs"
          target = "/tmp"
          tmpfs_options { size = 33554432 }
        }
        volumes = ["/opt/orca-job-api/source/nginx.conf:/etc/nginx/nginx.conf:ro"]
      }
      resources {
        cpu = 50
        memory = 64
      }
      service {
        name = "orca-job-api"
        port = "http"
        tags = [
          "traefik.enable=true",
          "traefik.http.routers.orca-job-api.rule=Host(`orca.bagelindustries.com`)",
          "traefik.http.routers.orca-job-api.entrypoints=web"
        ]
        check {
          type = "http"
          path = "/healthz"
          interval = "15s"
          timeout = "3s"
        }
      }
    }
  }
}
