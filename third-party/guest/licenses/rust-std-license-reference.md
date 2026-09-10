# Rust standard library license reference

The guest-agent executable links Rust `std`, `core`, `alloc`, and
`compiler_builtins` from the Rust 1.97.1 target toolchain used for the verified
rebuild. The official toolchain's generated library copyright inventory is
copied as [`rust-std-COPYRIGHT-library-1.97.1.html`](rust-std-COPYRIGHT-library-1.97.1.html),
279,302 bytes, SHA-256
`0a65bb747c49c7bb816cbc7188319bd6e4e8d08091c1190b8a3c0971c47968ed`.

The applicable Apache and MIT license texts are copied from the same official
toolchain documentation set as [`rust-std-LICENSE-APACHE-1.97.1.txt`](rust-std-LICENSE-APACHE-1.97.1.txt),
10,860 bytes, SHA-256
`8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb`, and
[`rust-std-LICENSE-MIT-1.97.1.txt`](rust-std-LICENSE-MIT-1.97.1.txt), 1,023
bytes, SHA-256
`23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3`.

The complete compiler toolchain is not redistributed; these three license and
copyright files are the required standard-library notices. The official Rust
source file is available at
<https://github.com/rust-lang/rust/blob/1.97.1/COPYRIGHT-library.html>. The
Rust compiler's separate `COPYRIGHT.html` is not a guest runtime dependency.
