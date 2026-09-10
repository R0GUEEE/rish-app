#!/bin/sh
# Fetch the bounded guest source-delivery set into a caller-selected directory.
# This intentionally does not fetch or extract the full Linux kernel source.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest="$script_dir/source-lock.tsv"
destination=${1:-}

if [ -z "$destination" ]; then
    printf '%s\n' "usage: $0 DESTINATION" >&2
    exit 2
fi
mkdir -p -- "$destination"

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

verify_file() {
    file_path=$1
    expected_size=$2
    expected_sha=$3
    [ -f "$file_path" ] || return 1
    actual_size=$(wc -c <"$file_path" | tr -d '[:space:]')
    [ "$actual_size" = "$expected_size" ] || return 1
    [ "$(sha256_file "$file_path")" = "$expected_sha" ]
}

tab=$(printf '\t')
while IFS="$tab" read -r source_id filename expected_size expected_sha url relation; do
    case "$source_id" in
        ''|'#'*) continue ;;
    esac
    target="$destination/$filename"
    if [ -e "$target" ]; then
        verify_file "$target" "$expected_size" "$expected_sha" || {
            printf 'source-collector: existing file failed verification: %s\n' "$target" >&2
            exit 1
        }
        printf 'verified  %s\n' "$target"
        continue
    fi
    command -v curl >/dev/null 2>&1 || {
        printf '%s\n' 'source-collector: curl is required for missing files' >&2
        exit 1
    }
    temporary="$target.tmp.$$"
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' --max-redirs 5 \
        --connect-timeout 15 --max-time 900 \
        --output "$temporary" "$url"
    verify_file "$temporary" "$expected_size" "$expected_sha" || {
        printf 'source-collector: downloaded file failed verification: %s\n' "$source_id" >&2
        exit 1
    }
    mv -- "$temporary" "$target"
    printf 'fetched   %s\n' "$target"
done <"$manifest"
