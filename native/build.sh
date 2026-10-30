#!/bin/sh
# Builds the universal (Apple Silicon + Intel) meeting-tap helper next to main.js.
set -e
cd "$(dirname "$0")"
for arch in arm64 x86_64; do
	swiftc -O -target "$arch-apple-macos14.2" meeting-tap.swift -o "meeting-tap-$arch"
done
lipo -create meeting-tap-arm64 meeting-tap-x86_64 -output ../meeting-tap
rm meeting-tap-arm64 meeting-tap-x86_64
codesign --force --sign - ../meeting-tap
