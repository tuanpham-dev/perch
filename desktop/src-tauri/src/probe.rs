// A minimal HTTP GET to a server on this machine, for "is a Perch answering
// on this port". Plain std so it works from any thread and from the
// headless CLI, with no async runtime around.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// The status code of `GET <path>` on 127.0.0.1:<port>, or None when nothing
/// answers within the timeout.
pub fn status(port: u16, path: &str, timeout: Duration) -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let request = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut head = [0u8; 32];
    let mut read = 0;
    while read < 12 {
        let n = stream.read(&mut head[read..]).ok()?;
        if n == 0 {
            break;
        }
        read += n;
    }
    parse_status(&head[..read])
}

/// `/tunnel.mjs` is public and only a Perch serves it, so a 200 there means
/// a Perch (signed in or not) is on that port.
pub fn is_perch(port: u16) -> bool {
    status(port, "/tunnel.mjs", Duration::from_millis(800)) == Some(200)
}

fn parse_status(head: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(head).ok()?;
    let mut parts = text.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_status_line() {
        assert_eq!(parse_status(b"HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status(b"HTTP/1.0 401 Unauthorized"), Some(401));
        assert_eq!(parse_status(b"SSH-2.0-OpenSSH"), None);
        assert_eq!(parse_status(b""), None);
    }

    #[test]
    fn nothing_listening_is_none() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(status(port, "/", Duration::from_millis(200)), None);
    }
}
