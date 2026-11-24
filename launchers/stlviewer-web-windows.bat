@echo off
title STLViewer Web Launcher
powershell -NoProfile -Command "foreach ($u in @('http://stl','http://192.168.1.100:8097','http://100.69.155.110:8097','https://meucak.github.io/stlviewer-web/')) { try { $r = Invoke-WebRequest -Uri $u -TimeoutSec 1 -UseBasicParsing; Start-Process $u; exit 0 } catch {} }; Start-Process 'https://meucak.github.io/stlviewer-web/'"
