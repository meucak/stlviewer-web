#!/usr/bin/env sh
# Opens the fastest reachable STLViewer Web endpoint (LAN -> Tailscale -> 24/7 GitHub Pages)
for url in "http://stl" "http://192.168.1.100:8097" "http://100.69.155.110:8097" "https://meucak.github.io/stlviewer-web/"; do
  if curl -fsS --max-time 1.2 "$url" >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
    exit 0
  fi
done
xdg-open "https://meucak.github.io/stlviewer-web/" >/dev/null 2>&1 &
