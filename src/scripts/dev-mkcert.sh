#!/bin/sh
mkdir -p ./certs
cd ./certs
mkcert -install
mkcert localhost
cd ..
