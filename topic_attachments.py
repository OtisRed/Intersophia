"""Validation and storage helpers for member-only meeting topic attachments."""

from io import BytesIO
from pathlib import PurePath
from urllib.parse import urlsplit

from PIL import Image, ImageOps
from werkzeug.utils import secure_filename

TOPIC_FILE_LIMIT_MB = 5
TOPIC_FILE_LIMIT = TOPIC_FILE_LIMIT_MB * 1024 * 1024
TOPIC_UPLOAD_LIMIT = 2 * TOPIC_FILE_LIMIT + 64 * 1024
TOPIC_LINK_LIMIT = 2048


def reading_link(value):
    try:
        link = urlsplit(value)
        port = link.port
    except ValueError:
        link = None
    if (len(value) > TOPIC_LINK_LIMIT or any(char.isspace() or ord(char) < 32 for char in value)
            or "\\" in value or not link or link.scheme not in {"http", "https"} or not link.hostname
            or link.username is not None or port == 0):
        raise ValueError("Podaj poprawny link HTTP lub HTTPS do materiału.")
    return value, None, None, None


def uploaded_bytes(upload, label):
    data = upload.read(TOPIC_FILE_LIMIT + 1)
    if not data or len(data) > TOPIC_FILE_LIMIT:
        raise ValueError(f"{label} musi mieć od 1 bajtu do {TOPIC_FILE_LIMIT_MB} MB.")
    return data


def reading_file(upload):
    data = uploaded_bytes(upload, "Plik do przeczytania")
    suffix = PurePath(upload.filename).suffix.lower()
    if suffix == ".pdf" and data.startswith(b"%PDF-") and b"%%EOF" in data[-4096:]:
        media_type = "application/pdf"
    elif suffix == ".txt" and b"\0" not in data:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("Plik TXT musi być zapisany w UTF-8.") from None
        media_type = "text/plain"
    else:
        raise ValueError("Wybierz materiał w formacie PDF lub TXT.")
    name = secure_filename(PurePath(upload.filename).stem)[:100] or "material"
    return None, name + suffix, media_type, data


def normalized_photo(upload, max_edge):
    data = uploaded_bytes(upload, "Zdjęcie")
    try:
        with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP"]) as image:
            if image.width * image.height > 25_000_000 or getattr(image, "is_animated", False):
                raise ValueError("Wybierz zdjęcie do 25 megapikseli, bez animacji.")
            photo = ImageOps.exif_transpose(image).convert("RGBA")
        photo.thumbnail((max_edge, max_edge))
        rgb = Image.new("RGB", photo.size, "white")
        rgb.paste(photo, mask=photo.getchannel("A"))
        output = BytesIO()
        rgb.save(output, format="JPEG", quality=90)
    except (OSError, SyntaxError, Image.DecompressionBombError):
        raise ValueError("Wybierz poprawny obraz JPEG, PNG lub WebP.") from None
    return output.getvalue()


def announcement_photo(upload):
    content = normalized_photo(upload, 2048)
    name = secure_filename(PurePath(upload.filename).stem)[:100] or "zdjecie"
    return None, name + ".jpg", "image/jpeg", content


def parse_topic_attachments(form, files):
    changes = {}
    url = form.get("reading_url", "").strip()
    material = files.get("reading_file")
    photo = files.get("photo")
    if url and material:
        raise ValueError("Dołącz link albo plik jako materiał do przeczytania.")
    if url:
        changes["reading"] = reading_link(url)
    elif material:
        changes["reading"] = reading_file(material)
    elif form.get("remove_reading"):
        changes["reading"] = None
    if photo:
        changes["photo"] = announcement_photo(photo)
    elif form.get("remove_photo"):
        changes["photo"] = None
    return changes


def save_topic_attachments(connection, topic_id, changes):
    for kind, attachment in changes.items():
        if attachment is None:
            connection.execute("DELETE FROM meeting_topic_attachments WHERE topic_id=? AND kind=?",
                               (topic_id, kind))
        else:
            connection.execute(
                "INSERT INTO meeting_topic_attachments (topic_id,kind,url,filename,media_type,content) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(topic_id,kind) DO UPDATE SET "
                "url=excluded.url, filename=excluded.filename, media_type=excluded.media_type, content=excluded.content",
                (topic_id, kind, *attachment),
            )
