#!/bin/sh
set -e
# The data volume is this container's disk. A fresh named volume is root-owned
# on Docker Desktop; fix it here so boot does not depend on the host uid.
mkdir -p /data/amazing-cli
chown -R amazing:amazing /data/amazing-cli
exec gosu amazing "$@"
