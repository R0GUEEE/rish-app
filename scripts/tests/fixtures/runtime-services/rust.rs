use std::fmt::Write as _;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c if c < '\u{20}' => { write!(&mut result, "\\u{:04x}", c as u32).unwrap(); }
            c => result.push(c),
        }
    }
    result.push('"');
    result
}

fn send(stream: &mut TcpStream, status: &str, payload: &str) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len())
}

fn serve(stream: &mut TcpStream, count: u64) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(&mut *stream);
    let mut lines = Vec::new();
    let mut header_size = 0;
    loop {
        let mut line = Vec::new();
        let read = reader.by_ref().take(65537).read_until(b'\n', &mut line)?;
        header_size += read;
        if read == 0 || header_size > 65536 {
            return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Invalid headers\"}");
        }
        if line == b"\r\n" { break; }
        let Ok(line) = String::from_utf8(line) else {
            return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Invalid headers\"}");
        };
        lines.push(line);
    }
    let parts: Vec<_> = lines.first().map_or("", String::as_str).split_whitespace().collect();
    if parts.len() != 3 {
        return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Invalid request\"}");
    }
    let (method, path) = (parts[0], parts[1]);
    let mut length = None;
    for line in lines.iter().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Invalid header\"}");
        };
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Unsupported body framing\"}");
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Duplicate length\"}");
            }
            length = match value.trim().parse::<usize>() {
                Ok(n) => Some(n),
                Err(_) => return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Invalid length\"}"),
            };
        }
    }
    let length = length.unwrap_or(0);
    if length > 65536 {
        io::copy(&mut reader.by_ref().take(65537), &mut io::sink())?;
        return send(reader.get_mut(), "413 Payload Too Large", "{\"error\":\"Body too large\"}");
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let Ok(body) = String::from_utf8(body) else {
        return send(reader.get_mut(), "400 Bad Request", "{\"error\":\"Body must be UTF-8\"}");
    };
    let payload = format!("{{\"family\":\"rust\",\"method\":{},\"path\":{},\"body\":{},\"count\":{count}}}", quote(method), quote(path), quote(&body));
    send(reader.get_mut(), "200 OK", &payload)
}

fn main() -> io::Result<()> {
    let port = std::env::args().nth(1).unwrap_or_else(|| "8080".into());
    let listener = TcpListener::bind(format!("0.0.0.0:{port}"))?;
    let mut count = 0u64;
    for connection in listener.incoming() {
        let mut stream = connection?;
        count += 1;
        if let Err(error) = serve(&mut stream, count) { eprintln!("{error}"); }
    }
    Ok(())
}
