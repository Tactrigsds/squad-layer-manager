#!/bin/sh
cd ./certs
mkcert -install
mkcert localhost
cd ..
