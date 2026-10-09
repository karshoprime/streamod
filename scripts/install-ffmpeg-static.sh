#!/usr/bin/env bash
# Install a current static FFmpeg build into /usr/local/bin.
#
# Streaming H.265/HEVC over RTMP needs FFmpeg 6.1+ (Enhanced RTMP). Ubuntu 22.04
# ships 4.4, which cannot do it. This installs a self-contained build next to
# the distro package without removing it; StreamFlow prefers /usr/local/bin.
#
# Usage:   sudo bash scripts/install-ffmpeg-static.sh
# Options: FFMPEG_URL=<tar.xz url>   use a specific build instead of auto-detect
#          INSTALL_DIR=/opt/ffmpeg-static   where the build is unpacked
#          BIN_DIR=/usr/local/bin           where ffmpeg/ffprobe are linked
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/ffmpeg-static}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
BASE_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"

case "$(uname -m)" in
  x86_64|amd64)  ARCH="linux64" ;;
  aarch64|arm64) ARCH="linuxarm64" ;;
  *) echo "❌ Arsitektur $(uname -m) tidak didukung oleh script ini."; exit 1 ;;
esac

for tool in curl tar xz; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ '$tool' belum terinstall. Jalankan: sudo apt install -y curl tar xz-utils"
    exit 1
  fi
done

url_exists() {
  curl -fsIL -o /dev/null "$1"
}

URL="${FFMPEG_URL:-}"
if [ -z "$URL" ]; then
  # Stable release branches, newest first. BtbN drops old branches over time,
  # so fall back to the master build if none of these exist anymore.
  for version in 8.1 8.0 7.1; do
    candidate="$BASE_URL/ffmpeg-n${version}-latest-${ARCH}-gpl-${version}.tar.xz"
    if url_exists "$candidate"; then
      URL="$candidate"
      break
    fi
  done
  if [ -z "$URL" ]; then
    URL="$BASE_URL/ffmpeg-master-latest-${ARCH}-gpl.tar.xz"
  fi
fi

echo "⬇️  Download: $URL"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fL --retry 3 -o "$TMP_DIR/ffmpeg.tar.xz" "$URL"

echo "📦 Extract ke $INSTALL_DIR"
mkdir -p "$TMP_DIR/unpacked"
tar -xJf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR/unpacked" --strip-components=1

if [ ! -x "$TMP_DIR/unpacked/bin/ffmpeg" ] || [ ! -x "$TMP_DIR/unpacked/bin/ffprobe" ]; then
  echo "❌ Arsip tidak berisi bin/ffmpeg dan bin/ffprobe."
  exit 1
fi

# Make sure the new binary actually runs here before replacing anything.
if ! "$TMP_DIR/unpacked/bin/ffmpeg" -hide_banner -version >/dev/null 2>&1; then
  echo "❌ Binary FFmpeg yang di-download tidak bisa dijalankan di server ini."
  exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
cp -a "$TMP_DIR/unpacked/." "$INSTALL_DIR/"
ln -sf "$INSTALL_DIR/bin/ffmpeg" "$BIN_DIR/ffmpeg"
ln -sf "$INSTALL_DIR/bin/ffprobe" "$BIN_DIR/ffprobe"

echo
echo "✅ Terpasang: $("$BIN_DIR/ffmpeg" -hide_banner -version | head -n 1)"
# Captured first: with pipefail, `ffmpeg | grep -q` fails when grep exits early.
ENCODERS="$("$BIN_DIR/ffmpeg" -hide_banner -encoders 2>/dev/null || true)"
if grep -q libx265 <<<"$ENCODERS"; then
  echo "✅ Encoder libx265 tersedia (untuk fitur Optimize for loop)"
else
  echo "⚠️  Encoder libx265 TIDAK ada di build ini"
fi
echo
echo "Restart aplikasi supaya FFmpeg baru dipakai, contoh: pm2 restart streamflow"
echo "Stream yang sedang live tetap memakai FFmpeg lama sampai di-restart."
