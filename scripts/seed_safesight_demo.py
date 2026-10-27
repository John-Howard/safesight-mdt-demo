"""
Seed a SafeSight instance with demo data for the MDT demonstrator.

Runs INSIDE SafeSight's Django shell. It writes demo rows to the target database
only and changes no SafeSight code:

    cd /path/to/safesight
    uv run python manage.py shell < /path/to/safesight-mdt-demo/scripts/seed_safesight_demo.py

    # or, with the Docker stack (the repo is bind-mounted at /app):
    docker exec -i safesight_web uv run python manage.py shell \
        < /path/to/safesight-mdt-demo/scripts/seed_safesight_demo.py

Idempotent: re-running deletes and recreates the demo files, AOIs and matches, and
resets the demo users' passwords. Never run it against production.

Creates, around central Oxford:
- "MDT Demo Fire Service" (MDTFIRE) with an AOI and a mix of located files
- "MDT Demo Ambulance Service" (MDTAMB), whose file falls inside the fire service's
  AOI and is shared via SafeSight's own spatial matching engine
- users mdt_demo (role "user", can download) and mdt_viewer (role "viewer", gets
  403 on download), password from $MDT_DEMO_PASSWORD, or a random one
  printed at the end when that is unset
"""

import io
import os
import secrets

from django.contrib.auth import get_user_model
from django.contrib.gis.geos import MultiPolygon, Point, Polygon
from django.core.files.base import ContentFile
from files import spatial_matching
from files.models import File, SpatialFileMatch
from organizations.models import AreaOfInterest, Organization
from PIL import Image, ImageDraw

# No default password: a known default would be a public credential on any
# reachable instance. Generate one per run unless the caller sets it.
PASSWORD = os.environ.get("MDT_DEMO_PASSWORD") or secrets.token_urlsafe(12)

# Central Oxford, roughly Carfax to the train station and down to the river.
AOI_RING = [
    (-1.2700, 51.7470),
    (-1.2450, 51.7470),
    (-1.2450, 51.7590),
    (-1.2700, 51.7590),
    (-1.2700, 51.7470),
]


def png_bytes(label: str, colour: str) -> bytes:
    """Draw a small labelled PNG so the preview has something to show."""
    image = Image.new("RGB", (480, 320), colour)
    draw = ImageDraw.Draw(image)
    draw.rectangle([10, 10, 470, 310], outline="white", width=4)
    draw.text((30, 150), label, fill="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def pdf_bytes(text: str) -> bytes:
    """Build a minimal one-page PDF without extra dependencies."""
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref_at = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    trailer = f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
    out.write(f"{trailer}startxref\n{xref_at}\n%%EOF\n".encode())
    return out.getvalue()


SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">'
    b'<rect width="200" height="100" fill="#c0392b"/>'
    b'<text x="20" y="55" fill="white">hydrant layout</text></svg>'
)


def upsert_org(name: str, code: str) -> Organization:
    org, _ = Organization.objects.update_or_create(
        code=code,
        defaults={
            "name": name,
            "contact_email": f"{code.lower()}@example.invalid",
            "allow_automatic_sharing": True,
            "default_share_permission": "download",
        },
    )
    return org


def upsert_user(username: str, org: Organization, role: str):
    user_model = get_user_model()
    user, _ = user_model.objects.update_or_create(
        username=username,
        defaults={"organization": org, "role": role, "is_active": True},
    )
    user.set_password(PASSWORD)
    user.save()
    return user


def add_file(org, user, filename, content, description, location=None, coverage=None):
    file_obj = File(
        organization=org,
        uploaded_by=user,
        description=description,
        location=location,
        coverage_area=coverage,
        location_status="manual",
        is_published=True,
    )
    file_obj.file.save(filename, ContentFile(content), save=False)
    file_obj.original_filename = filename
    file_obj.save()
    return file_obj


fire = upsert_org("MDT Demo Fire Service", "MDTFIRE")
ambulance = upsert_org("MDT Demo Ambulance Service", "MDTAMB")
demo_user = upsert_user("mdt_demo", fire, "user")
upsert_user("mdt_viewer", fire, "viewer")
ambulance_user = upsert_user("mdt_ambulance", ambulance, "user")

# Start clean so a re-run does not pile up duplicates.
demo_orgs = [fire, ambulance]
SpatialFileMatch.objects.filter(file__organization__in=demo_orgs).delete()
for old in File.objects.filter(organization__in=demo_orgs):
    old.file.delete(save=False)
    old.delete()
AreaOfInterest.objects.filter(organization__in=demo_orgs).delete()

aoi = AreaOfInterest.objects.create(
    organization=fire,
    name="Oxford city centre",
    description="MDT demo response area",
    geometry=MultiPolygon(Polygon(AOI_RING), srid=4326),
    created_by=demo_user,
)

add_file(
    fire,
    demo_user,
    "carfax-scene-photo.png",
    png_bytes("Carfax scene photo", "#1f6f8b"),
    "Scene photo at Carfax Tower",
    location=Point(-1.2577, 51.7520, srid=4326),
)
add_file(
    fire,
    demo_user,
    "station-incident-report.pdf",
    pdf_bytes("Incident report - Oxford station forecourt"),
    "Incident report, station forecourt",
    location=Point(-1.2700 + 0.0030, 51.7535, srid=4326),
)
add_file(
    fire,
    demo_user,
    "hydrant-notes.txt",
    b"Hydrant H-114: outside Covered Market, High St entrance.\n"
    b"Hydrant H-115: Turl St, north end.\n",
    "Hydrant locations",
    location=Point(-1.2545, 51.7525, srid=4326),
)
add_file(
    fire,
    demo_user,
    "hydrant-layout.svg",
    SVG,
    "SVG diagram, which the MDT serves as a download, never inline",
    location=Point(-1.2540, 51.7540, srid=4326),
)
add_file(
    fire,
    demo_user,
    "river-flood-extent.txt",
    b"Flood extent survey, Thames towpath by Folly Bridge.\n",
    "Coverage polygon only, no point location",
    coverage=Polygon(
        [
            (-1.2580, 51.7465),
            (-1.2530, 51.7465),
            (-1.2530, 51.7490),
            (-1.2580, 51.7490),
            (-1.2580, 51.7465),
        ],
        srid=4326,
    ),
)
add_file(
    fire,
    demo_user,
    "headington-outside-area.txt",
    b"This file is outside the AOI and must not appear in the MDT.\n",
    "Outside the AOI (negative control)",
    location=Point(-1.2100, 51.7600, srid=4326),
)

shared = add_file(
    ambulance,
    ambulance_user,
    "ambulance-staging-point.png",
    png_bytes("Ambulance staging point", "#8e44ad"),
    "Ambulance service file, shared into the fire service AOI by spatial matching",
    location=Point(-1.2600, 51.7550, srid=4326),
)
matches = spatial_matching.generate_matches_for_file(shared)

print(f"Seeded AOI {aoi.id} '{aoi.name}' for {fire.name}")
print(f"Files: {File.objects.filter(organization__in=demo_orgs).count()} total")
print(f"Spatial matches for the shared ambulance file: {len(matches)}")
print(f"Users: mdt_demo (download), mdt_viewer (viewer, 403 on download); password: {PASSWORD}")
