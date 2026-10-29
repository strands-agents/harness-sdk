"""Integration tests for S3VectorSearchStrategy against real S3, S3 Vectors and Bedrock.

Creates a throwaway S3 bucket plus a ``<bucket>-vectors`` vector bucket and ``default`` index, and
tears all three down afterwards.
"""

import asyncio
import time
import uuid

import boto3
import pytest

from strands.storage import S3Storage
from strands.storage.search import S3VectorSearchStrategy
from tests_integ._aws import resolve_region

REGION = resolve_region()

# Titan Text Embeddings V2, the default embedder, produces 1024-dimensional vectors.
TITAN_V2_DIMENSION = 1024


@pytest.fixture(scope="module")
def boto_session():
    return boto3.Session(region_name=REGION)


@pytest.fixture(scope="module")
def buckets(boto_session):
    """Create the S3 bucket, vector bucket and index; delete them after the module's tests."""
    account = boto_session.client("sts").get_caller_identity()["Account"]
    bucket = f"test-strands-s3v-{account}-{REGION}-{uuid.uuid4().hex[:8]}"
    vector_bucket = f"{bucket}-vectors"
    s3 = boto_session.client("s3")
    s3_vectors = boto_session.client("s3vectors")

    if REGION == "us-east-1":
        s3.create_bucket(Bucket=bucket)
    else:
        s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION})
    s3_vectors.create_vector_bucket(vectorBucketName=vector_bucket)
    s3_vectors.create_index(
        vectorBucketName=vector_bucket,
        indexName="default",
        dataType="float32",
        dimension=TITAN_V2_DIMENSION,
        distanceMetric="cosine",
    )

    yield bucket, vector_bucket

    # Best-effort teardown: each step runs even if an earlier one fails, so nothing is left behind.
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket):
            objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
            if objects:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": objects})
    finally:
        for cleanup in (
            lambda: s3_vectors.delete_index(vectorBucketName=vector_bucket, indexName="default"),
            lambda: s3_vectors.delete_vector_bucket(vectorBucketName=vector_bucket),
            lambda: s3.delete_bucket(Bucket=bucket),
        ):
            try:
                cleanup()
            except Exception as error:
                print(f"teardown step failed: {error}")


def make_storage(boto_session, buckets, prefix=""):
    """A storage on the test bucket whose strategy uses the test vector index.

    The strategy gets no embedder or session, so its S3 Vectors client and default Bedrock embedder
    come from the storage's ``boto_session``.
    """
    bucket, vector_bucket = buckets
    return S3Storage(
        bucket,
        prefix=prefix,
        boto_session=boto_session,
        search_strategy=S3VectorSearchStrategy(vector_bucket_name=vector_bucket, index_name="default"),
    )


async def search_until(storage, query, predicate, timeout=30.0, interval=1.0):
    """Poll ``storage.search(query)`` until ``predicate`` holds; raise if the timeout elapses first."""
    deadline = time.monotonic() + timeout
    while True:
        results = await storage.search(query)
        if predicate(results):
            return results
        if time.monotonic() >= deadline:
            keys = [result.key for result in results]
            raise AssertionError(
                f"search({query!r}) did not reach the expected state within {timeout}s; last keys: {keys}"
            )
        await asyncio.sleep(interval)


def keys(results):
    return [result.key for result in results]


@pytest.mark.asyncio
async def test_indexes_on_write_finds_content_by_meaning_and_deindexes_on_delete(boto_session, buckets):
    storage = make_storage(boto_session, buckets, prefix="semantic")
    await storage.write("pets.md", b"My golden retriever loves to fetch tennis balls in the park.")
    await storage.write("finance.md", b"Quarterly revenue grew twelve percent on strong cloud sales.")

    query = "dog playing outside"
    results = await search_until(storage, query, lambda found: {"pets.md", "finance.md"} <= set(keys(found)))
    scores = {result.key: result.score for result in results}
    assert keys(results)[0] == "pets.md"
    assert 0 < scores["finance.md"] < scores["pets.md"] <= 1

    await storage.delete("pets.md")
    after_delete = await search_until(storage, query, lambda found: "pets.md" not in keys(found))
    assert "finance.md" in keys(after_delete)


@pytest.mark.asyncio
async def test_isolates_storages_that_share_the_index_under_different_prefixes(boto_session, buckets):
    parent = make_storage(boto_session, buckets, prefix="agents")
    first = make_storage(boto_session, buckets, prefix="agents/a")
    second = make_storage(boto_session, buckets, prefix="agents/b")
    await first.write("notes.md", b"The deployment pipeline runs integration tests before release.")
    await first.write("a-only.md", b"The release checklist for the deployment pipeline.")
    await second.write("notes.md", b"The deployment pipeline runs integration tests before release.")

    # Wait until every vector is visible, so the per-prefix assertions below can't pass vacuously.
    query = "deployment pipeline"
    expected = {"a/notes.md", "a/a-only.md", "b/notes.md"}
    await search_until(parent, query, lambda found: expected <= set(keys(found)))

    assert sorted(keys(await first.search(query))) == ["a-only.md", "notes.md"]
    assert keys(await second.search(query)) == ["notes.md"]
    assert sorted(keys(await parent.namespace("a").search(query))) == ["a-only.md", "notes.md"]

    # Deleting the first storage's notes.md must not remove the second's vector for the same key.
    await first.delete("notes.md")
    after_delete = await search_until(first, query, lambda found: "notes.md" not in keys(found))
    assert keys(after_delete) == ["a-only.md"]
    assert keys(await second.search(query)) == ["notes.md"]


@pytest.mark.asyncio
async def test_removes_the_old_vector_when_a_text_key_is_overwritten_with_binary_data(boto_session, buckets):
    storage = make_storage(boto_session, buckets, prefix="binary")
    await storage.write("photo.md", b"A sunset over the mountains with orange and purple clouds.")
    await search_until(storage, "sunset mountains", lambda found: "photo.md" in keys(found))

    await storage.write("photo.md", b"\xff\xd8\xff\xe0\x00\x10JFIF")

    await search_until(storage, "sunset mountains", lambda found: "photo.md" not in keys(found))
    assert await storage.read("photo.md") == b"\xff\xd8\xff\xe0\x00\x10JFIF"
