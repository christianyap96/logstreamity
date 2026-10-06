@echo off
rem Starts the local proxy (serves the site + forwards Dynatrace API calls without CORS). Needs Node 18+.
echo Starting Logstreamity local proxy on http://127.0.0.1:8090 ...
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8090/platform.html"
node "%~dp0server\local-proxy.mjs"
