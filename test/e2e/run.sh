#!/usr/bin/env bash
# End-to-end: build a throwaway Jenkins (Podman or Docker), seed it with the fixture jobs, run the audit against it.
set -euo pipefail
cd "$(dirname "$0")"
RT=$(command -v podman || command -v docker)
$RT build -q -t jenkins-e2e . >/dev/null
$RT rm -f jenkins-e2e >/dev/null 2>&1 || true
$RT run -d --name jenkins-e2e -p 18080:8080 jenkins-e2e >/dev/null
J=http://localhost:18080
for i in $(seq 1 60); do curl -sf "$J/api/json" >/dev/null && break; sleep 3; done
JAR=$(mktemp); CRUMB=$(curl -s -c "$JAR" -b "$JAR" "$J/crumbIssuer/api/json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['crumbRequestField']+':'+d['crumb'])")
mk() { curl -s -c "$JAR" -b "$JAR" -o /dev/null -w "%{http_code} $1\n" -H "$CRUMB" -H "Content-Type: application/xml" --data-binary @"$2" "$J/${3:-}createItem?name=$1"; }
mk widgets-nightly ../fixtures/freestyle-maven.config.xml
mk inline-pipeline ../fixtures/pipeline-inline.config.xml
mk api-pipeline ../fixtures/pipeline-scm.config.xml
mk platform folder.xml
mk service-mb multibranch.xml job/platform/
sed 's#<disabled>false</disabled>#<disabled>true</disabled>#' ../fixtures/freestyle-maven.config.xml > "$JAR.disabled.xml"; mk old-nightly "$JAR.disabled.xml" job/platform/
OUT=$(mktemp -d)
node ../../cli/index.js audit --url "$J" --out "$OUT"
grep -q "Multibranch pipeline" "$OUT/report.md" && grep -q "Disabled (1)" "$OUT/report.md" && echo "e2e ok: $OUT/report.md"
$RT rm -f jenkins-e2e >/dev/null
