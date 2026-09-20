#!/usr/bin/env python3
"""
Genera el catálogo de la biblioteca.

Lee la carpeta de Google Drive (o, para pruebas, una carpeta local con --local),
saca la portada de cada libro (primera página del PDF o imagen de portada del EPUB)
y escribe:

    web/data/catalog.json      lista de libros
    web/covers/<id>.jpg        una portada por libro

Es incremental: solo descarga los libros nuevos o modificados desde la última vez.

Autenticación (una de las dos, como variable de entorno / secreto de GitHub):
    GDRIVE_API_KEY              clave de API (carpeta compartida con "cualquier persona con el enlace")
    GDRIVE_SERVICE_ACCOUNT      JSON de una cuenta de servicio (carpeta compartida con su correo)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import sys
import time
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA_DIR = WEB / "data"
COVERS_DIR = WEB / "covers"

FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"
GDOC = "application/vnd.google-apps.document"

DEFAULT_CONFIG = {
    "folderId": "",
    "siteTitle": "Biblioteca de la Amistad",
    "siteSubtitle": "Asociación de Amistad con China",
    "authorFolderCollections": [],
    "authorFromFilename": False,
    "authorFromMetadata": False,
    "extensions": ["pdf", "epub", "mobi", "azw3", "docx", "doc", "txt", "rtf", "odt"],
    "maxDownloadMB": 150,
    "maxNewCoversPerRun": 300,
    "coverWidth": 400,
    "collectionOrder": [],
    "unknownCollection": "Otros textos",
}

BAD_META = re.compile(
    r"(microsoft|word|adobe|acrobat|admin|user|usuario|unknown|desconocid|scan|\.docx?\b|\.pdf\b|untitled|sin t[ií]tulo|^\s*$)",
    re.I,
)


def log(*args):
    print(*args, flush=True)


def die(msg: str):
    print(f"\nERROR: {msg}\n", file=sys.stderr, flush=True)
    sys.exit(1)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fold(s: str) -> str:
    """Minúsculas y sin acentos, para comparar y ordenar."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower().strip()


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"{path.name} no es un JSON válido: {e}")


# ───────────────────────── Origen de datos ─────────────────────────


class DriveError(Exception):
    pass


class DriveSource:
    API = "https://www.googleapis.com/drive/v3"
    FIELDS = (
        "nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,"
        "webViewLink,shortcutDetails(targetId,targetMimeType))"
    )

    def __init__(self):
        import requests

        self.requests = requests
        sa = os.environ.get("GDRIVE_SERVICE_ACCOUNT", "").strip()
        key = os.environ.get("GDRIVE_API_KEY", "").strip()
        if sa:
            from google.auth.transport.requests import AuthorizedSession
            from google.oauth2 import service_account

            try:
                info = json.loads(sa)
            except json.JSONDecodeError:
                die("El secreto GDRIVE_SERVICE_ACCOUNT no contiene un JSON válido. Pega el archivo .json completo.")
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=["https://www.googleapis.com/auth/drive.readonly"]
            )
            self.http = AuthorizedSession(creds)
            self.params = {}
            log("Acceso a Drive: cuenta de servicio")
        elif key:
            self.http = requests.Session()
            self.params = {"key": key}
            log("Acceso a Drive: clave de API")
        else:
            die(
                "Falta el acceso a Drive. Crea el secreto GDRIVE_API_KEY (o GDRIVE_SERVICE_ACCOUNT) "
                "en GitHub: Settings > Secrets and variables > Actions."
            )

    def _get(self, url, params=None, stream=False):
        p = dict(self.params)
        p.update(params or {})
        last = None
        for attempt in range(5):
            try:
                r = self.http.get(url, params=p, stream=stream, timeout=180)
            except self.requests.RequestException as e:
                last = str(e)
                time.sleep(2**attempt)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                last = f"HTTP {r.status_code}"
                time.sleep(2**attempt)
                continue
            if r.status_code >= 400:
                raise DriveError(self._explain(r.status_code, r.text))
            return r
        raise DriveError(f"Google Drive no responde ({last}).")

    @staticmethod
    def _explain(status: int, text: str) -> str:
        detail = re.sub(r"\s+", " ", text)[:300]
        hint = ""
        if status in (400, 401, 403, 404):
            hint = (
                " Comprueba que: (1) la carpeta está compartida con 'Cualquier persona con el enlace' "
                "(o con el correo de la cuenta de servicio); (2) la API de Google Drive está activada en "
                "tu proyecto de Google Cloud; (3) la clave de API es correcta y no la has restringido "
                "a otra API."
            )
        return f"Drive respondió con el código {status}.{hint} Detalle: {detail}"

    def children(self, folder_id: str):
        token = None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed = false",
                "fields": self.FIELDS,
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
                "orderBy": "name",
            }
            if token:
                params["pageToken"] = token
            data = self._get(f"{self.API}/files", params).json()
            yield from data.get("files", [])
            token = data.get("nextPageToken")
            if not token:
                break

    def walk(self, root_id: str):
        seen = set()
        stack = [(root_id, [])]
        while stack:
            folder_id, path = stack.pop()
            if folder_id in seen:
                continue
            seen.add(folder_id)
            for f in self.children(folder_id):
                name = f.get("name", "")
                if name.startswith((".", "~$")):
                    continue
                fid, mime = f["id"], f.get("mimeType", "")
                is_shortcut = mime == SHORTCUT
                if mime == SHORTCUT:
                    sd = f.get("shortcutDetails") or {}
                    fid, mime = sd.get("targetId"), sd.get("targetMimeType", "")
                    if not fid:
                        continue
                if mime == FOLDER:
                    stack.append((fid, path + [name]))
                    continue
                yield {
                    "id": fid,
                    "name": name,
                    "path": path,
                    "mime": mime,
                    "size": int(f["size"]) if f.get("size") else None,
                    "md5": f.get("md5Checksum"),
                    "modified": f.get("modifiedTime"),
                    "created": f.get("createdTime") or f.get("modifiedTime"),
                    "web": f.get("webViewLink"),
                    "shortcut": is_shortcut,
                }

    def download(self, item, limit: int) -> bytes:
        r = self._get(
            f"{self.API}/files/{item['id']}",
            {"alt": "media", "supportsAllDrives": "true"},
            stream=True,
        )
        buf, total = io.BytesIO(), 0
        for chunk in r.iter_content(1 << 18):
            total += len(chunk)
            if total > limit:
                r.close()
                raise DriveError("archivo demasiado grande para sacar la portada")
            buf.write(chunk)
        return buf.getvalue()

    @staticmethod
    def view_url(item) -> str:
        return item.get("web") or f"https://drive.google.com/file/d/{item['id']}/view"

    @staticmethod
    def download_url(item) -> str | None:
        if item.get("mime") == GDOC:
            return f"https://docs.google.com/document/d/{item['id']}/export?format=pdf"
        return f"https://drive.google.com/uc?export=download&id={item['id']}"


class LocalSource:
    """Para probar sin Drive: una carpeta local con la misma estructura."""

    def __init__(self, root: str):
        self.root = Path(root)
        if not self.root.is_dir():
            die(f"La carpeta local {root} no existe.")

    def walk(self, _root_id):
        for p in sorted(self.root.rglob("*")):
            if p.is_dir() or p.name.startswith((".", "~$")):
                continue
            rel = p.relative_to(self.root)
            st = p.stat()
            yield {
                "id": hashlib.sha1(str(rel).encode("utf-8")).hexdigest()[:16],
                "name": p.name,
                "path": list(rel.parts[:-1]),
                "mime": "",
                "size": st.st_size,
                "md5": None,
                "modified": iso(st.st_mtime),
                "created": iso(st.st_mtime),
                "web": None,
                "local": p,
            }

    def download(self, item, limit: int) -> bytes:
        return item["local"].read_bytes()

    @staticmethod
    def view_url(item):
        return ""

    @staticmethod
    def download_url(item):
        return ""


# ───────────────────────── Portadas y metadatos ─────────────────────────


def to_jpeg(img: Image.Image, width: int) -> bytes:
    img = img.convert("RGB")
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=82, optimize=True, progressive=True)
    return out.getvalue()


def looks_blank(img: Image.Image) -> bool:
    stat = ImageStat.Stat(img.convert("L").resize((80, 120)))
    return stat.stddev[0] < 4


def pdf_info(data: bytes, width: int) -> dict:
    try:
        import pymupdf
    except ImportError:  # versiones antiguas
        import fitz as pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    info = {"pages": doc.page_count}
    meta = doc.metadata or {}
    info["metaAuthor"] = (meta.get("author") or "").strip()
    info["metaTitle"] = (meta.get("title") or "").strip()
    if doc.needs_pass or doc.page_count == 0:
        return info
    chosen = None
    for i in range(min(3, doc.page_count)):
        page = doc[i]
        zoom = width / max(page.rect.width, 1)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        if chosen is None:
            chosen = img
        if not looks_blank(img):
            chosen = img
            break
    if chosen is not None:
        info["jpeg"] = to_jpeg(chosen, width)
    return info


def epub_info(data: bytes, width: int) -> dict:
    z = zipfile.ZipFile(io.BytesIO(data))
    ns_c = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    ns_o = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
    container = ET.fromstring(z.read("META-INF/container.xml"))
    opf_path = container.find(".//c:rootfile", ns_c).get("full-path")
    opf = ET.fromstring(z.read(opf_path))
    base = posixpath.dirname(opf_path)
    info = {"pages": None}
    t = opf.find(".//dc:title", ns_o)
    a = opf.find(".//dc:creator", ns_o)
    info["metaTitle"] = (t.text or "").strip() if t is not None and t.text else ""
    info["metaAuthor"] = (a.text or "").strip() if a is not None and a.text else ""

    manifest = {i.get("id"): i for i in opf.findall(".//o:manifest/o:item", ns_o)}
    cover = None
    for m in opf.findall(".//o:metadata/o:meta", ns_o):
        if m.get("name") == "cover":
            cover = manifest.get(m.get("content"))
    if cover is None:
        for i in manifest.values():
            if "cover-image" in (i.get("properties") or ""):
                cover = i
                break
    if cover is None:
        for i in manifest.values():
            is_img = (i.get("media-type") or "").startswith("image/")
            if is_img and "cover" in ((i.get("id") or "") + (i.get("href") or "")).lower():
                cover = i
                break
    if cover is not None:
        path = posixpath.normpath(posixpath.join(base, unquote(cover.get("href"))))
        info["jpeg"] = to_jpeg(Image.open(io.BytesIO(z.read(path))), width)
    return info


# ───────────────────────── Reglas de título, autor y colección ─────────────────────────


def clean_text(s: str) -> str:
    s = s.replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


def clean_author(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip(" .,;:-–—")


def strip_ext(name: str, exts) -> str:
    stem, dot, ext = name.rpartition(".")
    if dot and ext.lower() in exts:
        return stem
    return name


def looks_like_name(s: str) -> bool:
    words = s.split()
    if not 2 <= len(words) <= 5 or any(ch.isdigit() for ch in s):
        return False
    if fold(s).startswith(("tomo", "vol", "parte", "capitulo", "libro", "anexo", "obras", "historia")):
        return False
    return sum(1 for w in words if w[0].isupper()) >= len(words) - 1


def split_author_from_filename(stem: str):
    parts = re.split(r"\s+[-–—]\s+", stem, maxsplit=1)
    if len(parts) == 2 and looks_like_name(parts[0].strip()) and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return None, stem


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", help="usar una carpeta local en lugar de Drive (pruebas)")
    ap.add_argument("--retry-covers", action="store_true", help="reintentar las portadas que fallaron")
    ap.add_argument("--force", action="store_true", help="publicar aunque falten muchos libros respecto a la vez anterior")
    args = ap.parse_args()

    cfg = {**DEFAULT_CONFIG, **load_json(ROOT / "config.json", {})}
    overrides = load_json(ROOT / "overrides.json", {})
    book_over = overrides.get("books", {})
    author_alias = {fold(k): v for k, v in overrides.get("authors", {}).items()}
    exts = {e.lower().lstrip(".") for e in cfg["extensions"]}
    author_colls = {fold(c) for c in cfg["authorFolderCollections"]}
    width = int(cfg["coverWidth"])
    limit_bytes = int(cfg["maxDownloadMB"]) * 1024 * 1024
    max_new = int(cfg["maxNewCoversPerRun"])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    COVERS_DIR.mkdir(parents=True, exist_ok=True)

    prev_path = DATA_DIR / "catalog.json"
    prev_data = load_json(prev_path, {"books": []})
    prev = {b["id"]: b for b in prev_data.get("books", [])}

    if args.local:
        source = LocalSource(args.local)
        root_id = ""
        log(f"Modo local: {args.local}")
    else:
        root_id = os.environ.get("FOLDER_ID") or cfg["folderId"]
        if not root_id:
            die("Falta el identificador de la carpeta: rellena folderId en config.json.")
        source = DriveSource()

    log("Leyendo la carpeta…")
    try:
        items = list(source.walk(root_id))
    except DriveError as e:
        die(str(e))

    books, skipped = [], 0
    stats = {"reused": 0, "new": 0, "failed": 0, "pending": 0, "no_cover": 0}
    new_done = 0
    problems = []

    # Un atajo puede apuntar a un libro que ya está en la lista: se queda el libro real.
    best = {}
    for it in items:
        cur = best.get(it["id"])
        if cur is None or (cur.get("shortcut") and not it.get("shortcut")):
            best[it["id"]] = it
    items = sorted(best.values(), key=lambda it: ([fold(p) for p in it["path"]], fold(it["name"])))
    for it in items:
        ext = it["name"].rpartition(".")[2].lower() if "." in it["name"] else ""
        if it.get("mime") == GDOC:
            fmt = "gdoc"
        elif ext in exts:
            fmt = ext
        else:
            skipped += 1
            continue

        rel = "/".join(it["path"] + [it["name"]])
        sig = it["md5"] or f"{it['size']}-{it['modified']}"
        old = prev.get(it["id"])
        cover_rel, pages, meta_author, meta_title, cover_error, pending = None, None, "", "", None, False

        can_extract = fmt in ("pdf", "epub")
        cached = (
            old
            and old.get("sig") == sig
            and not old.get("pending")
            and not (old.get("coverError") and args.retry_covers)
            and (not old.get("cover") or (WEB / old["cover"]).exists())
        )
        if cached:
            cover_rel, pages = old.get("cover"), old.get("pages")
            meta_author, meta_title = old.get("metaAuthor", ""), old.get("metaTitle", "")
            cover_error = old.get("coverError")
            stats["reused"] += 1
        elif can_extract:
            if new_done >= max_new:
                pending = True
                stats["pending"] += 1
            else:
                new_done += 1
                try:
                    if it["size"] and it["size"] > limit_bytes:
                        raise DriveError(f"pesa más de {cfg['maxDownloadMB']} MB")
                    log(f"  [{new_done}] {rel}")
                    data = source.download(it, limit_bytes)
                    info = pdf_info(data, width) if fmt == "pdf" else epub_info(data, width)
                    pages = info.get("pages")
                    meta_author, meta_title = info.get("metaAuthor", ""), info.get("metaTitle", "")
                    if info.get("jpeg"):
                        safe = re.sub(r"[^A-Za-z0-9_-]", "_", it["id"])
                        (COVERS_DIR / f"{safe}.jpg").write_bytes(info["jpeg"])
                        cover_rel = f"covers/{safe}.jpg"
                        stats["new"] += 1
                    else:
                        stats["no_cover"] += 1
                except Exception as e:  # una portada que falla no debe parar todo
                    cover_error = str(e)[:140] or e.__class__.__name__
                    stats["failed"] += 1
                    problems.append(f"{rel}: {cover_error}")
        # (docx, txt, etc.: sin portada; la aplicación dibuja una)

        # ---- colección, autor y título ----
        over = book_over.get(it["id"]) or book_over.get(rel) or {}
        collection = it["path"][0] if it["path"] else cfg["unknownCollection"]
        rest = it["path"][1:]
        stem = clean_text(strip_ext(it["name"], exts))
        title, author = stem, None

        if it["path"] and fold(collection) in author_colls and rest:
            author, rest = clean_author(rest[0]), rest[1:]
        if not author and cfg["authorFromFilename"]:
            a, t = split_author_from_filename(stem)
            if a:
                author, title = clean_author(a), t
        if not author and cfg["authorFromMetadata"] and meta_author and not BAD_META.search(meta_author):
            author = clean_author(meta_author)

        if author:
            author = author_alias.get(fold(author), author)
        title = over.get("title", title)
        author = over.get("author", author) or None
        collection = over.get("collection", collection)
        section = " / ".join(clean_text(p) for p in rest)

        books.append(
            {
                "id": it["id"],
                "title": title,
                "author": author,
                "collection": collection,
                "section": section,
                "format": fmt,
                "size": it["size"],
                "pages": pages,
                "added": it["created"],
                "modified": it["modified"],
                "cover": cover_rel,
                "url": source.view_url(it),
                "download": source.download_url(it),
                "sig": sig,
                "metaAuthor": meta_author,
                "metaTitle": meta_title,
                "coverError": cover_error,
                "pending": pending,
            }
        )

    # ---- salvaguardas antes de publicar ----
    if not books:
        die(
            "No se ha encontrado ningún libro. Revisa el folderId de config.json y que la carpeta "
            f"tenga archivos con estas extensiones: {', '.join(sorted(exts))}."
        )
    if not args.force and len(prev) >= 10 and len(books) < len(prev) * 0.5:
        die(
            f"Hay {len(books)} libros y la última vez había {len(prev)}. Por seguridad no se publica. "
            "Si es correcto (has borrado muchos libros), ejecuta con --force."
        )

    # ---- orden de colecciones ----
    order = {fold(c): i for i, c in enumerate(cfg["collectionOrder"])}
    names = sorted({b["collection"] for b in books}, key=lambda c: (order.get(fold(c), 10**6), fold(c)))
    books.sort(key=lambda b: (names.index(b["collection"]), fold(b["author"] or "~"), fold(b["title"])))

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "title": cfg["siteTitle"],
        "subtitle": cfg["siteSubtitle"],
        "collections": names,
        "books": books,
    }
    lines = ",\n".join(json.dumps(b, ensure_ascii=False, separators=(",", ":")) for b in books)
    head = json.dumps({k: v for k, v in out.items() if k != "books"}, ensure_ascii=False, separators=(",", ":"))
    prev_path.write_text(head[:-1] + ',"books":[\n' + lines + "\n]}\n", encoding="utf-8")

    # ---- limpiar portadas huérfanas ----
    used = {Path(b["cover"]).name for b in books if b["cover"]}
    removed = 0
    for f in COVERS_DIR.glob("*.jpg"):
        if f.name not in used:
            f.unlink()
            removed += 1

    # ---- resumen ----
    no_author = sum(1 for b in books if not b["author"])
    summary = [
        f"Libros: {len(books)} en {len(names)} colecciones",
        f"Autores distintos: {len({b['author'] for b in books if b['author']})} (sin autor: {no_author})",
        f"Portadas: {stats['new']} nuevas, {stats['reused']} reutilizadas, "
        f"{stats['no_cover']} sin imagen, {stats['failed']} con error, {stats['pending']} pendientes",
        f"Archivos ignorados por extensión: {skipped}",
    ]
    log("\n" + "\n".join(summary))
    if stats["pending"]:
        log(f"Quedan {stats['pending']} portadas por procesar: vuelve a ejecutar el workflow (o espera a la próxima ejecución diaria).")
    if problems:
        log("\nPortadas que han fallado:")
        for p in problems[:30]:
            log("  -", p)
    step = os.environ.get("GITHUB_STEP_SUMMARY")
    if step:
        with open(step, "a", encoding="utf-8") as fh:
            fh.write("### Resultado\n\n" + "\n".join(f"- {s}" for s in summary) + "\n")
            if problems:
                fh.write("\n**Portadas con error**\n\n" + "\n".join(f"- {p}" for p in problems[:30]) + "\n")


if __name__ == "__main__":
    main()
