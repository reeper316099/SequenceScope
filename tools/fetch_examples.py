"""Download the bundled example sequences from their real sources by accession.

Why: the project rule is "never type or recall a sequence from memory". Every record in
examples/ is produced by this script from UniProt or NCBI, then checksummed (SHA-256) and
described in a metadata.json (source, accession, retrieval date, license sentence, citation).

Run:  python3 -I tools/fetch_examples.py        (needs Biopython; see tools/README.md)
Network is needed ONLY for this script, never by the app.
"""

import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / ".pylibs"))  # local pip --target folder (gitignored)

from io import StringIO  # noqa: E402

from Bio import SeqIO  # noqa: E402

OUT = ROOT / "examples"
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")

# License sentences were read from the live pages/files on the day recorded in `license_checked`.
UNIPROT_LICENSE = {
    "name": "CC BY 4.0",
    "quote": "We have chosen to apply the Creative Commons Attribution 4.0 International (CC BY 4.0) "
    "License (https://creativecommons.org/licenses/by/4.0/) to all copyrightable parts of our databases.",
    "source_url": "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/complete/LICENSE",
    "license_checked": TODAY,
}
NCBI_LICENSE = {
    "name": "NCBI data policy (no NCBI restrictions; submitter rights possible)",
    "quote": "NCBI itself places no restrictions on the use or distribution of the data contained therein.",
    "caveat": "Some submitters of the original data may claim patent, copyright, or other intellectual "
    "property rights in all or a portion of the data (same policy page).",
    "source_url": "https://www.ncbi.nlm.nih.gov/home/about/policies/",
    "license_checked": TODAY,
}

# --- Example set definitions (accessions only; sequences come from the databases) -------------
HBA = [  # UniProtKB/Swiss-Prot "Hemoglobin subunit alpha", resolved via the UniProt REST search.
    "P69905", "P69907", "P01923", "P63108", "P01942", "P01946", "P01966",
    "P01958", "P60529", "P01965", "P01994", "P07428", "Q90487",
]
NEAR_IDENTICAL = ["P69905", "P69907", "P01923", "P63108"]  # human, chimp, gorilla, rhesus alpha-globin
PAIR_GAPPED = ["P69905", "P68871"]  # human alpha- vs beta-globin: related, different lengths -> gaps
PAIR_UNRELATED = ["P69905", "P01308"]  # human alpha-globin vs human insulin precursor

MITO = {  # RefSeq mitochondrial genomes; the CYTB coding sequence is cut out using the record's own annotation
    "NC_012920.1": "Homo sapiens", "NC_001643.1": "Pan troglodytes",
    "NC_011120.1": "Gorilla gorilla gorilla", "NC_002083.1": "Pongo abelii",
    "NC_002082.1": "Hylobates lar", "NC_005943.1": "Macaca mulatta",
    "NC_020006.2": "Papio anubis", "NC_005089.1": "Mus musculus",
    "NC_006853.1": "Bos taurus", "NC_002008.4": "Canis lupus familiaris",
}


def http_get(url: str) -> tuple[str, dict[str, str]]:
    """GET a URL and return (text, headers); NCBI is rate-limited so callers sleep between calls."""
    req = urllib.request.Request(url, headers={"User-Agent": "SequenceScope-example-fetcher/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (fixed https hosts)
        return r.read().decode("utf-8"), {k.lower(): v for k, v in r.headers.items()}


def fetch_uniprot(acc: str) -> dict:
    """Fetch one UniProt FASTA record and keep its release number for provenance."""
    text, hdr = http_get(f"https://rest.uniprot.org/uniprotkb/{acc}.fasta")
    rec = next(SeqIO.parse(StringIO(text), "fasta"))
    return {"accession": acc, "header": rec.description, "sequence": str(rec.seq),
            "release": hdr.get("x-uniprot-release", "unknown"), "database": "UniProtKB"}


def fetch_cytb(acc: str, organism: str) -> dict:
    """Fetch a RefSeq mito genome (GenBank format) and extract exactly one CYTB CDS from its annotation."""
    q = urllib.parse.urlencode({"db": "nuccore", "id": acc, "rettype": "gb", "retmode": "text"})
    text, _ = http_get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?{q}")
    time.sleep(0.5)
    rec = next(SeqIO.parse(StringIO(text), "genbank"))
    hits = [f for f in rec.features if f.type == "CDS" and "CYTB" in
            [g.upper() for g in f.qualifiers.get("gene", [])]]
    if len(hits) != 1:
        raise SystemExit(f"{acc}: expected exactly one CYTB CDS, found {len(hits)}")
    f = hits[0]
    seq = str(f.extract(rec.seq))
    start, end, strand = int(f.location.start) + 1, int(f.location.end), f.location.strand
    return {"accession": acc, "organism": organism, "record_organism": rec.annotations.get("organism"),
            "header": f"{rec.id}:{start}-{end}({'+' if strand == 1 else '-'}) CYTB {rec.annotations.get('organism')}",
            "sequence": seq, "database": "NCBI Nucleotide (RefSeq)", "genbank_date": rec.annotations.get("date"),
            "cds_location": f"{start}..{end} strand {strand}", "translation_note":
            "CDS extracted from the record's own gene=CYTB annotation (not re-typed)."}


def write_set(name: str, title: str, records: list[dict], molecule: str, license_: dict,
              citation: str, notes: str, purpose: str) -> None:
    """Write one example set: FASTA (60 columns), checksum, and a metadata.json beside it."""
    d = OUT / name
    d.mkdir(parents=True, exist_ok=True)
    lines = []
    for r in records:
        lines.append(">" + r["header"])
        s = r["sequence"]
        lines += [s[i:i + 60] for i in range(0, len(s), 60)]
    fasta = "\n".join(lines) + "\n"
    (d / "sequences.fasta").write_text(fasta, encoding="utf-8")
    meta = {
        "id": name, "title": title, "molecule": molecule, "purpose": purpose,
        "retrieved": TODAY, "fasta_file": "sequences.fasta",
        "fasta_sha256": hashlib.sha256(fasta.encode("utf-8")).hexdigest(),
        "license": license_, "citation": citation, "notes": notes,
        "records": [{k: v for k, v in r.items() if k != "sequence"} | {
            "length": len(r["sequence"]),
            "sequence_sha256": hashlib.sha256(r["sequence"].encode()).hexdigest()} for r in records],
    }
    (d / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {name}: {len(records)} records")


def main() -> None:
    """Fetch every record once, then assemble all example sets."""
    cache: dict[str, dict] = {}
    for acc in sorted(set(HBA + PAIR_GAPPED + PAIR_UNRELATED)):
        cache[acc] = fetch_uniprot(acc)
        time.sleep(0.2)
    uni_cite = ("The UniProt Consortium. UniProt: the Universal Protein Knowledgebase. "
                "Nucleic Acids Research (see https://www.uniprot.org/help/publications for the current reference).")
    pick = lambda accs: [cache[a] for a in accs]  # noqa: E731
    write_set("globin_alpha_vertebrates", "Hemoglobin subunit alpha across 13 vertebrates", pick(HBA), "protein",
              UNIPROT_LICENSE, uni_cite, "Expected: primates cluster together, rodents together, fish/frog/bird outside mammals.",
              "Protein family for distances, trees, and MSA.")
    write_set("globin_alpha_primates_near_identical", "Alpha-globin of human, chimp, gorilla, rhesus (near-identical)",
              pick(NEAR_IDENTICAL), "protein", UNIPROT_LICENSE, uni_cite,
              "Very similar sequences; shows near-zero distances and trivially clean alignments.", "Near-identical demo.")
    write_set("pair_globin_alpha_beta_gaps", "Human alpha- vs beta-globin (related, gapped)", pick(PAIR_GAPPED), "protein",
              UNIPROT_LICENSE, uni_cite, "Distant paralogs with different lengths; alignment needs gaps.", "Gap demo pair.")
    write_set("pair_unrelated", "Human alpha-globin vs human insulin precursor (unrelated)", pick(PAIR_UNRELATED),
              "protein", UNIPROT_LICENSE, uni_cite, "No real homology expected; shows what a noise alignment looks like.",
              "Unrelated-pair demo.")
    cytb = [fetch_cytb(a, o) for a, o in MITO.items()]
    write_set("mito_cytb_mammals", "Mitochondrial CYTB coding sequence, 7 primates + mouse, cow, dog", cytb, "dna",
              NCBI_LICENSE, "Sayers EW et al. GenBank / NCBI Nucleotide; cite each RefSeq accession (see records).",
              "Rapidly evolving third codon positions; mouse/cow/dog show higher divergence.", "DNA set for distance models/saturation.")


def write_index() -> None:
    """Write examples/index.json (list of set ids + titles) from the per-set metadata files, so the app can list them."""
    sets = []
    for meta_path in sorted(OUT.glob("*/metadata.json")):
        m = json.loads(meta_path.read_text())
        sets.append({"id": m["id"], "title": m["title"], "molecule": m["molecule"], "records": len(m["records"]),
                     "aligned": "aligned" in m})
    (OUT / "index.json").write_text(json.dumps({"sets": sets}, indent=2) + "\n", encoding="utf-8")
    print(f"wrote index.json with {len(sets)} sets")


if __name__ == "__main__":
    if "--index-only" in sys.argv:
        write_index()
    else:
        main()
        write_index()
