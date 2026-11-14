#!/bin/bash
# Установка всего, что нужно для сборки под iOS 6, в одну команду.
#
# Что делает:
#   1. достаёт из архива Ubuntu компилятор clang 15 (исходники ld64 2015 года
#      не собираются clang 17 — блоки Objective-C);
#   2. ставит libBlocksRuntime (пакет распаковывается в свою папку, без root);
#   3. собирает заглушку libdispatch (в Ubuntu 25.10 её нет);
#   4. собирает Apple ld64 из cctools-port — он умеет armv7;
#   5. проверяет результат пробной линковкой.
#
# Ожидает уже распакованный SDK iOS 6.1 в $ROOT/ios6-sdk (его достаёт Fcode
# из образа Xcode 4.6.3 через 7-Zip).
set -e
set -o pipefail

# ROOT передаёт Fcode: это папка в профиле пользователя, а не фиксированный
# путь разработчика. Без него ставить некуда — сразу говорим об этом.
if [ -z "$ROOT" ]; then
  echo "[ios6] не задан ROOT: Fcode должен передать папку для тулчейна" >&2
  exit 2
fi

CLANGROOT=$ROOT/clang15/root
DEPS=$ROOT/cctools-deps
STUB=$ROOT/dispatch-stub
WORK=$ROOT/cctools-build
PREFIX=$ROOT/cctools-install

# SDK ищем в дереве: раскладка образа Xcode 4.6.x зависит от версии.
SDK=$(find "$ROOT/ios6-sdk" -maxdepth 12 -type d -name 'iPhoneOS*.sdk' 2>/dev/null | head -1)

say() { echo "[ios6] $*"; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$STUB/dispatch"
cp -f "$SCRIPT_DIR/dispatch/dispatch.h" "$STUB/dispatch/" 2>/dev/null || true
cp -f "$SCRIPT_DIR/dispatch_stub.c" "$STUB/" 2>/dev/null || true

# ---------------------------------------------------------------- 1. clang 15
if [ ! -x "$CLANGROOT/usr/lib/llvm-15/bin/clang" ]; then
  say "качаю clang 15 и библиотеки"
  mkdir -p "$CLANGROOT/../deb" "$CLANGROOT"
  cd "$CLANGROOT/../deb"

  fetch() {
    local base=$1 pattern=$2 name
    name=$(wget -qO- "$base/" 2>/dev/null | grep -o "href=\"$pattern\"" | sed 's/href="//;s/"//' | sort -u | tail -1 || true)
    [ -z "$name" ] && { say "  нет: $pattern"; return 0; }
    [ -f "$name" ] && return 0
    say "  $name"
    wget -q "$base/$name" -O "$name"
  }

  U=http://archive.ubuntu.com/ubuntu/pool/universe/l/llvm-toolchain-15
  M=http://archive.ubuntu.com/ubuntu/pool/main/l/llvm-toolchain-15
  fetch "$U" 'clang-15_[^"]*amd64\.deb'
  fetch "$U" 'libclang-cpp15t64_[^"]*amd64\.deb'
  fetch "$U" 'libclang-common-15-dev_[^"]*amd64\.deb'
  fetch "$M" 'libllvm15_[^"]*amd64\.deb'

  for deb in *.deb; do [ -f "$deb" ] && dpkg -x "$deb" "$CLANGROOT"; done
fi

# libxml2 и icu старой версии: clang-15 собран против них
mkdir -p "$DEPS/oldlibs"
if [ -z "$(find "$DEPS/oldlibs" -name 'libxml2.so.2' 2>/dev/null)" ]; then
  say "качаю libxml2 и libicu60"
  cd "$DEPS/oldlibs"
  for pool in "http://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/ libxml2_[^\"']*amd64\.deb" \
              "http://archive.ubuntu.com/ubuntu/pool/main/i/icu/ libicu60_[^\"']*amd64\.deb"; do
    set -- $pool
    name=$(wget -qO- "$1" | grep -o "href=\"$2\"" | sed 's/href="//;s/"//' | sort -u | tail -1 || true)
    [ -n "$name" ] && wget -q "$1/$name" -O "$name" || true
  done
  for deb in *.deb; do [ -f "$deb" ] && dpkg -x "$deb" .; done
fi

export LD_LIBRARY_PATH=$(find "$CLANGROOT" "$DEPS/oldlibs" \
  \( -name 'libLLVM*.so*' -o -name 'libclang*.so*' -o -name 'libxml2.so*' -o -name 'libicu*.so*' \) \
  -printf '%h\n' 2>/dev/null | sort -u | tr '\n' ':')
export CC="$CLANGROOT/usr/lib/llvm-15/bin/clang"
export CXX="$CLANGROOT/usr/lib/llvm-15/bin/clang++"
export PATH="$CLANGROOT/usr/lib/llvm-15/bin:$PATH"

say "компилятор: $($CC --version | head -1)"

# ------------------------------------------------------ 2. libBlocksRuntime
if [ -z "$(find "$DEPS/root" -name 'Block.h' 2>/dev/null)" ]; then
  say "качаю libBlocksRuntime"
  mkdir -p "$DEPS/deb" "$DEPS/root"
  cd "$DEPS/deb"
  for pkg in libblocksruntime-dev libblocksruntime0; do
    ls ${pkg}_*.deb >/dev/null 2>&1 || apt-get download "$pkg" >/dev/null 2>&1 || true
  done
  for deb in *.deb; do [ -f "$deb" ] && dpkg -x "$deb" "$DEPS/root"; done
fi

BLOCK_INC=$(dirname "$(find "$DEPS/root" -name 'Block.h' | head -1)")
BLOCK_LIB=$(dirname "$(find "$DEPS/root" -name 'libBlocksRuntime.so*' | head -1)")

# --------------------------------------------------------- 3. libdispatch
mkdir -p "$STUB/bin"
if [ ! -f "$STUB/bin/libdispatch.so" ]; then
  say "собираю заглушку libdispatch"
  "$CC" -shared -fblocks -O2 -I"$STUB" "$STUB/dispatch_stub.c" \
    -o "$STUB/bin/libdispatch.so" -Wl,-soname,libdispatch.so \
    -L"$BLOCK_LIB" -lBlocksRuntime -Wl,-rpath,"$BLOCK_LIB"
fi

# -------------------------------------------------------------- 4. ld64
if [ ! -x "$WORK/cctools-port/cctools/ld64/src/ld/ld" ]; then
  say "собираю Apple ld64 (это самая долгая часть)"
  mkdir -p "$WORK"
  cd "$WORK"
  [ -d cctools-port ] || git clone --depth 1 --recursive https://github.com/tpoechtrager/cctools-port.git

  cd "$WORK/cctools-port/cctools"
  export CPPFLAGS="-I$STUB -I$BLOCK_INC"
  export CFLAGS="-I$STUB -I$BLOCK_INC"
  export LDFLAGS="-L$STUB/bin -L$BLOCK_LIB -Wl,-rpath,$STUB/bin -Wl,-rpath,$BLOCK_LIB"
  ./configure --prefix="$PREFIX" --target=x86_64-apple-darwin11 >/dev/null
  make -j"$(nproc)" >/dev/null
fi

LD=$WORK/cctools-port/cctools/ld64/src/ld/ld

# ------------------------------------------------------------- 5. проверка
say "проверяю линкер"
if [ ! -d "$SDK" ]; then
  say "НЕТ SDK: $SDK"
  exit 2
fi

TMP=$(mktemp -d)
echo 'int main(void){return 0;}' > "$TMP/t.c"
"$CC" -target armv7-apple-ios6.1 -isysroot "$SDK" -c "$TMP/t.c" -o "$TMP/t.o"
"$LD" -arch armv7 -ios_version_min 6.1 -syslibroot "$SDK" -L"$SDK/usr/lib" \
  -lSystem -o "$TMP/app" "$TMP/t.o" 2>/dev/null

if head -c 4 "$TMP/app" | od -An -tx1 | grep -q 'ce fa ed fe'; then
  say "ГОТОВО: ld64 собирает armv7"
else
  say "ОШИБКА: линкер не выдал Mach-O"
  exit 3
fi
