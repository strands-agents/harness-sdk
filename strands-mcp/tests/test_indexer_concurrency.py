"""Concurrency and failure-path tests for the search index and page cache.

Each test MUST fail on the unfixed code and pass after the fix:
  - lost-update race on the shared inverted index (doc_frequency / postings)
  - a page being cached before its content is successfully indexed
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from unittest.mock import MagicMock, patch

import pytest

from strands_mcp_server.utils import cache, indexer


class TestBlocker1DeterministicRace:
    """Deterministic reproduction of BLOCKER 1: race in read-modify-write on doc_frequency.

    Monkeypatches the extracted ``IndexSearch._bump_df`` seam to force interleaving at
    the critical read-modify-write:
        current_df = doc_frequency.get(tok, 0)  # READ
        <forced context switch>                 # <-- barrier
        doc_frequency[tok] = current_df + 1      # WRITE

    Without the lock, both threads read the same value (0), then both write 1.
    With the lock, operations are serialized, so no race occurs.

    This test MUST FAIL when the lock is removed/bypassed.
    """

    def test_deterministic_lost_increment_via_forced_interleaving(self, monkeypatch):
        """Force two threads to interleave at the read-modify-write seam.

        Scenario WITHOUT lock:
        - Thread A reads doc_frequency["racetoken"]=0, then yields at barrier
        - Thread B reads doc_frequency["racetoken"]=0 (same!), then yields
        - Both threads pass barrier
        - Thread A writes doc_frequency["racetoken"]=1
        - Thread B writes doc_frequency["racetoken"]=1  (LOST INCREMENT!)

        Expected with lock: doc_frequency["racetoken"]=2, postings=[0,1]
        Expected WITHOUT lock: doc_frequency["racetoken"]=1, postings=[0,1] (CORRUPTION)

        The invariant df == len(postings) catches this.
        """
        # Use threading primitives to force interleaving
        barrier = threading.Barrier(2, timeout=0.1)
        thread_count_at_seam = [0]
        seam_lock = threading.Lock()

        def yield_at_seam():
            """Called between read and write in the critical section.

            With proper locking, only one thread enters the critical section at a time,
            so the barrier will timeout (one waiter, never reaches 2).

            Without locking, both threads can be in the critical section simultaneously,
            both reach the barrier, and pass through - exposing the race.
            """
            with seam_lock:
                thread_count_at_seam[0] += 1
            try:
                barrier.wait()  # Will timeout if only one thread reaches here
            except threading.BrokenBarrierError:
                pass  # Expected when lock serializes access

        idx = indexer.IndexSearch()

        def racy_bump_df(tok: str) -> None:
            """Replacement _bump_df that yields between the df read and write."""
            current_df = idx.doc_frequency.get(tok, 0)
            yield_at_seam()
            idx.doc_frequency[tok] = current_df + 1

        monkeypatch.setattr(idx, "_bump_df", racy_bump_df)

        errors = []

        doc_a = indexer.Doc(
            uri="https://example.com/a",
            display_title="Doc A",
            content="racetoken",
            index_title="doc a",
        )
        doc_b = indexer.Doc(
            uri="https://example.com/b",
            display_title="Doc B",
            content="racetoken",
            index_title="doc b",
        )

        def add_doc_a():
            try:
                idx.add(doc_a)
            except threading.BrokenBarrierError:
                pass  # Expected when lock serializes
            except Exception as e:
                errors.append(e)

        def add_doc_b():
            try:
                idx.add(doc_b)
            except threading.BrokenBarrierError:
                pass  # Expected when lock serializes
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=add_doc_a)
        t2 = threading.Thread(target=add_doc_b)
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert not errors, f"Threads raised unexpected exceptions: {errors}"

        # INTEGRITY CHECK: df must equal len(postings)
        df = idx.doc_frequency.get("racetoken", 0)
        postings = idx.doc_indices.get("racetoken", [])

        # With proper locking, both increments are serialized: df=2, postings=[0,1]
        # Without locking + forced interleaving: df=1, postings=[0,1] → CORRUPTION
        assert df == len(postings), (
            f"RACE DETECTED: doc_frequency['racetoken']={df} != len(postings)={len(postings)}. "
            f"Lost increment due to unserialized read-modify-write. Postings: {postings}"
        )
        assert df == 2, (
            f"Expected df=2 (both docs indexed), got df={df}. Lost increment indicates missing lock protection."
        )

    def test_deterministic_race_with_many_threads(self, monkeypatch):
        """Stress variant: many threads all racing on the same token.

        With N threads each adding a doc with "stresstoken", expected df=N.
        Without locking + forced interleaving, many increments will be lost.
        """
        num_threads = 10
        barrier = threading.Barrier(num_threads, timeout=0.1)

        def yield_at_seam():
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass  # Expected when lock serializes access

        idx = indexer.IndexSearch()

        def racy_bump_df(tok: str) -> None:
            """Replacement _bump_df that yields between the df read and write."""
            current_df = idx.doc_frequency.get(tok, 0)
            yield_at_seam()
            idx.doc_frequency[tok] = current_df + 1

        monkeypatch.setattr(idx, "_bump_df", racy_bump_df)

        errors = []

        docs = [
            indexer.Doc(
                uri=f"https://example.com/stress{i}",
                display_title=f"Stress Doc {i}",
                content="stresstoken",
                index_title=f"stress doc {i}",
            )
            for i in range(num_threads)
        ]

        def add_doc(doc):
            try:
                idx.add(doc)
            except threading.BrokenBarrierError:
                pass  # Expected when lock serializes
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=add_doc, args=(docs[i],)) for i in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert not errors, f"Threads raised unexpected exceptions: {errors}"

        df = idx.doc_frequency.get("stresstoken", 0)
        postings = idx.doc_indices.get("stresstoken", [])

        # Critical invariant: df == len(postings)
        assert df == len(postings), (
            f"RACE DETECTED: df={df} != len(postings)={len(postings)}. "
            f"Lost {len(postings) - df} increments due to concurrent read-modify-write."
        )
        # All N docs should be counted
        assert df == num_threads, f"Expected df={num_threads}, got df={df}. Lost {num_threads - df} increments."


class TestBlocker1ConcurrentIndexCorruption:
    """Reproduce BLOCKER 1: concurrent add/update_content corrupts index integrity.

    The bot demonstrated: 60 postings → df=48 (lost increments), same-URI duplication
    (N=1, df=2, postings [0,0]), negative scores.

    These tests verify the INTERFACE contract: that concurrent operations preserve
    index integrity invariants (df == len(postings), no duplicate postings, df <= N).
    """

    def test_concurrent_add_preserves_integrity_invariants(self):
        """Concurrent add() calls must preserve: df == len(postings), df <= N.

        Without locking, concurrent increments to doc_frequency[token] can be lost:
        Thread A reads df=5, Thread B reads df=5, both write df=6 → lost increment.

        The fix (threading.Lock) ensures these invariants hold under concurrent access.
        """
        index = indexer.IndexSearch()
        num_docs = 100
        num_threads = 10

        # All docs share this token so they all increment doc_frequency["shared"]
        docs = [
            indexer.Doc(
                uri=f"https://example.com/doc{i}",
                display_title=f"Doc {i}",
                content="shared token here unique" + str(i),
                index_title=f"doc {i}",
            )
            for i in range(num_docs)
        ]

        def add_batch(start, end):
            for i in range(start, end):
                index.add(docs[i])

        # Concurrent adds
        batch_size = num_docs // num_threads
        with ThreadPoolExecutor(max_workers=num_threads) as executor:
            futures = [executor.submit(add_batch, i * batch_size, (i + 1) * batch_size) for i in range(num_threads)]
            for f in as_completed(futures):
                f.result()

        # INTEGRITY INVARIANTS that must hold after concurrent operations:
        actual_df = index.doc_frequency.get("shared", 0)
        actual_postings = len(index.doc_indices.get("shared", []))
        actual_N = len(index.docs)

        # Invariant 1: df must equal len(postings) for each token
        assert actual_df == actual_postings, (
            f"Invariant violated: df ({actual_df}) != len(postings) ({actual_postings})"
        )
        # Invariant 2: df must not exceed N
        assert actual_df <= actual_N, f"Invariant violated: df ({actual_df}) > N ({actual_N})"
        # Invariant 3: N must equal expected (no lost docs)
        assert actual_N == num_docs, f"docs list corrupted: expected {num_docs}, got {actual_N}"
        # Invariant 4: all docs added, so df should equal N for 'shared'
        assert actual_df == num_docs, f"doc_frequency lost increments: expected {num_docs}, got {actual_df}"

    def test_concurrent_update_content_preserves_integrity_invariants(self):
        """Concurrent update_content() calls must preserve index integrity.

        Scenario: prefetch daemon thread + foreground ensure_page() both call
        update_content() on the same or different URIs concurrently.

        Without locking, the interleaving of:
        1. read old_tokens
        2. compute new_tokens
        3. update doc_frequency (decrement for removed, increment for added)
        4. update doc_indices (remove idx from old, add to new)
        can corrupt the index.
        """
        index = indexer.IndexSearch()
        num_docs = 50

        # Add docs with empty content
        for i in range(num_docs):
            doc = indexer.Doc(
                uri=f"https://example.com/page{i}",
                display_title=f"Page {i}",
                content="",
                index_title=f"page {i}",
            )
            index.add(doc)

        barrier = threading.Barrier(2)
        errors = []

        def updater_a():
            """Simulates prefetch daemon."""
            try:
                barrier.wait(timeout=5)
                for i in range(num_docs):
                    index.update_content(f"https://example.com/page{i}", f"hydrated content alpha doc{i}")
            except Exception as e:
                errors.append(e)

        def updater_b():
            """Simulates foreground ensure_page."""
            try:
                barrier.wait(timeout=5)
                for i in range(num_docs):
                    index.update_content(f"https://example.com/page{i}", f"hydrated content alpha doc{i}")
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=updater_a)
        t2 = threading.Thread(target=updater_b)
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert not errors, f"Exceptions during concurrent update: {errors}"

        # INTEGRITY INVARIANTS after concurrent updates:
        alpha_df = index.doc_frequency.get("alpha", 0)
        alpha_postings = index.doc_indices.get("alpha", [])

        # Invariant 1: df == len(postings)
        assert alpha_df == len(alpha_postings), (
            f"Invariant violated: df ({alpha_df}) != len(postings) ({len(alpha_postings)})"
        )
        # Invariant 2: no duplicate indices in postings
        assert len(alpha_postings) == len(set(alpha_postings)), "Invariant violated: duplicate indices in postings list"
        # Invariant 3: df should equal num_docs (all docs have 'alpha')
        assert alpha_df == num_docs, f"doc_frequency corrupted: expected {num_docs}, got {alpha_df}"

    def test_concurrent_operations_never_produce_negative_scores(self):
        """Concurrent add() + update_content() must never produce negative TF-IDF scores.

        Race conditions can lead to corrupted doc_frequency values which could
        produce unexpected IDF values. TF-IDF scores should always be non-negative.
        """
        index = indexer.IndexSearch()

        # Add initial doc
        doc = indexer.Doc(
            uri="https://example.com/race",
            display_title="Race Doc",
            content="",
            index_title="race doc",
        )
        index.add(doc)

        barrier = threading.Barrier(3)
        negative_scores = []

        def adder():
            """Add more docs concurrently."""
            barrier.wait(timeout=5)
            for i in range(20):
                new_doc = indexer.Doc(
                    uri=f"https://example.com/new{i}",
                    display_title=f"New {i}",
                    content="commonterm specialword",
                    index_title=f"new {i}",
                )
                index.add(new_doc)

        def updater():
            """Update existing doc concurrently."""
            barrier.wait(timeout=5)
            for _ in range(20):
                index.update_content("https://example.com/race", "commonterm updated content")
                time.sleep(0.001)

        def searcher():
            """Search during mutations and record any negative scores."""
            barrier.wait(timeout=5)
            for _ in range(20):
                results = index.search("commonterm")
                for score, doc in results:
                    if score < 0:
                        negative_scores.append((score, doc.uri))
                time.sleep(0.001)

        threads = [
            threading.Thread(target=adder),
            threading.Thread(target=updater),
            threading.Thread(target=searcher),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        # No negative scores should have been observed
        assert not negative_scores, f"Negative scores observed: {negative_scores[:5]}"

        # Final integrity check: verify all invariants hold
        N = len(index.docs)
        for token, df in index.doc_frequency.items():
            postings = index.doc_indices.get(token, [])
            # Invariant: df == len(postings)
            assert df == len(postings), f"Invariant violated for {token}: df={df}, len(postings)={len(postings)}"
            # Invariant: df <= N
            assert df <= N, f"Invariant violated: doc_frequency[{token}]={df} exceeds N={N}"


class TestBlocker2CacheBeforeIndexing:
    """Reproduce BLOCKER 2: page cached before indexing succeeds.

    If update_content() raises, the page is already in _URL_CACHE, so subsequent
    calls return the cached page and never retry indexing → body search permanently empty.
    """

    @pytest.fixture(autouse=True)
    def reset_cache_state(self):
        """Reset cache module global state before each test."""
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False
        yield
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False

    def test_indexing_failure_leaves_page_unsearchable_forever(self):
        """When update_content raises, the page should NOT be cached (or should be retryable).

        Current bug: page is assigned to _URL_CACHE BEFORE update_content() is called.
        If update_content() raises, the page is cached but body terms are not indexed.
        Subsequent calls return the cached page, never retrying indexing.
        """
        # Setup: index with a doc that has empty content
        cache._INDEX = indexer.IndexSearch()
        url = "https://strandsagents.com/broken.md"
        cache._URL_CACHE[url] = None

        doc = indexer.Doc(
            uri=url,
            display_title="Broken Doc",
            content="",
            index_title="broken doc",
        )
        cache._INDEX.add(doc)

        # Verify: "specialterm" not yet searchable
        results_before = cache._INDEX.search("specialterm")
        assert len(results_before) == 0

        # Mock fetch to succeed but update_content to fail
        mock_raw = MagicMock()
        mock_raw.title = "Broken Doc"
        mock_raw.content = "This has specialterm that should be searchable."

        call_count = [0]
        original_update = cache._INDEX.update_content

        def failing_update(uri, content):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("Simulated indexing failure")
            return original_update(uri, content)

        with patch("strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean", return_value=mock_raw):
            with patch("strands_mcp_server.utils.cache.text_processor.format_display_title", return_value="Broken Doc"):
                with patch.object(cache._INDEX, "update_content", side_effect=failing_update):
                    # First call: fetch succeeds, indexing fails
                    cache.ensure_page(url)

        # The page should either be None (not cached) or retriable
        # Current bug: page1 is not None because it was cached before indexing

        # Second call: should retry indexing, not return stale cached page
        with patch("strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean", return_value=mock_raw):
            with patch("strands_mcp_server.utils.cache.text_processor.format_display_title", return_value="Broken Doc"):
                # This time update_content should succeed (call_count[0] > 1)
                cache.ensure_page(url)

        # After retry, the term should be searchable
        results_after = cache._INDEX.search("specialterm")
        assert len(results_after) == 1, (
            f"Body term 'specialterm' not searchable after retry - "
            f"page was cached before indexing and never retried. "
            f"Got {len(results_after)} results."
        )

    def test_fetch_failure_is_negatively_cached_until_ttl(self):
        """When fetch_and_clean raises, the URL is negatively cached for the TTL
        (no immediate re-fetch), then re-fetched once the entry expires."""
        cache._INDEX = indexer.IndexSearch()
        url = "https://strandsagents.com/flaky.md"
        cache._URL_CACHE[url] = None

        doc = indexer.Doc(
            uri=url,
            display_title="Flaky Doc",
            content="",
            index_title="flaky doc",
        )
        cache._INDEX.add(doc)

        call_count = [0]

        def flaky_fetch(u):
            call_count[0] += 1
            if call_count[0] == 1:
                raise ConnectionError("Network flake")
            mock_raw = MagicMock()
            mock_raw.title = "Flaky Doc"
            mock_raw.content = "flakyterm content here"
            return mock_raw

        with patch("strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean", side_effect=flaky_fetch):
            with patch("strands_mcp_server.utils.cache.text_processor.format_display_title", return_value="Flaky Doc"):
                # First call: fetch fails
                page1 = cache.ensure_page(url)
                assert page1 is None

                # The URL is negatively cached as a _FailedEntry, not left at None
                entry = cache._URL_CACHE.get(url)
                assert isinstance(entry, cache._FailedEntry)

                # Within TTL: short-circuited, no re-fetch attempt
                page2 = cache.ensure_page(url)
                assert page2 is None
                assert call_count[0] == 1

                # Expire the entry: next call re-fetches and succeeds
                entry._timestamp -= cache._FAILED_TTL_SECONDS + 1
                page3 = cache.ensure_page(url)
                assert page3 is not None
                assert call_count[0] == 2

        # Term should be searchable
        results = cache._INDEX.search("flakyterm")
        assert len(results) == 1


class TestUpdateContentAtomicity:
    """update_content() must be atomic: a failure mid-reindex must not commit
    content early, so the idempotence guard allows a retry to re-run."""

    @pytest.fixture(autouse=True)
    def reset_cache_state(self):
        """Reset cache module global state before each test."""
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False
        yield
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False

    def test_update_content_atomic_on_mid_loop_failure(self, monkeypatch):
        """yonib05's finding: if the postings loop raises after doc.content is set,
        the idempotence guard must NOT make retries a no-op. Content is committed
        last, so a failed reindex leaves content unchanged and retry re-runs."""
        from strands_mcp_server.utils import indexer as idx_mod

        index = idx_mod.IndexSearch()
        index.add(idx_mod.Doc(uri="u1", display_title="Guardrails", index_title="Guardrails", content=""))

        body = "You can set a guardrail temperature threshold for the model."

        # Inject a failure on the first token's df write, mid-transaction, via the
        # extracted _bump_df seam. Later calls delegate to the real increment so the
        # retry below actually re-runs the reindex.
        calls = {"n": 0}

        def boom_bump(tok):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("simulated failure mid-transaction")
            index.doc_frequency[tok] = index.doc_frequency.get(tok, 0) + 1

        monkeypatch.setattr(index, "_bump_df", boom_bump)

        try:
            index.update_content("u1", body)
        except RuntimeError:
            pass

        # After the failed update, body terms must not be silently lost forever:
        # retry must actually re-run (content was NOT committed on failure)
        retried = index.update_content("u1", body)
        assert retried is True
        results = index.search("temperature")
        assert any(doc.uri == "u1" for _, doc in results), (
            "page must be searchable by body term after retry — "
            "content was not committed on the failed attempt, so retry re-indexed it"
        )


class TestNeedsHydrationMutant:
    """Regression: needs_hydration forced to always-True must be caught.

    A mutant that makes needs_hydration() always return True would cause
    unnecessary re-fetches of cached Pages and expired _FailedEntry checks
    to be skipped.
    """

    @pytest.fixture(autouse=True)
    def reset_cache_state(self):
        """Reset cache module global state before each test."""
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False
        yield
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False

    def test_needs_hydration_false_for_unexpired_failed_entry(self):
        """needs_hydration must return False for a non-expired _FailedEntry."""
        url = "https://strandsagents.com/failed.md"
        entry = cache._FailedEntry()
        cache._URL_CACHE[url] = entry

        # Entry is fresh — should NOT need hydration
        assert not cache.needs_hydration(url), (
            "needs_hydration() returned True for an unexpired _FailedEntry; "
            "mutant survives if this passes with always-True"
        )

    def test_needs_hydration_true_after_ttl_expires(self):
        """needs_hydration must return True once the _FailedEntry TTL expires."""
        url = "https://strandsagents.com/flaky.md"
        entry = cache._FailedEntry()
        cache._URL_CACHE[url] = entry

        # Expire the entry
        entry._timestamp -= cache._FAILED_TTL_SECONDS + 1

        assert cache.needs_hydration(url), (
            "needs_hydration() returned False for an expired _FailedEntry; the TTL logic is broken"
        )


class TestRaceConditionFailureDoesNotClobberPage:
    """Regression: a failed fetch must not clobber an existing cached Page.

    Scenario: Thread B starts fetching (cache is empty). Thread A finishes and
    caches a Page while Thread B is still fetching. Thread B's fetch fails.
    Thread B must NOT overwrite Thread A's Page with a _FailedEntry.
    """

    @pytest.fixture(autouse=True)
    def reset_cache_state(self):
        """Reset cache module global state before each test."""
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False
        yield
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False

    def test_failure_does_not_clobber_existing_page(self, monkeypatch):
        """A failed fetch must leave an existing cached Page intact.

        Simulates: Thread B reads cache (None), starts fetch. Thread A caches a
        Page during B's fetch. Thread B's fetch fails. The failure handler must
        check the cache again under lock and NOT clobber the Page.
        """
        from strands_mcp_server.utils import doc_fetcher

        url = "https://strandsagents.com/good.md"

        # Start with empty cache
        cache._URL_CACHE[url] = None

        # Index is required for ensure_page to proceed
        cache._INDEX = indexer.IndexSearch()
        cache._INDEX.add(indexer.Doc(uri=url, display_title="Good Doc", content="", index_title="good doc"))

        # Simulate Thread A inserting a Page during Thread B's fetch
        existing_page = doc_fetcher.Page(url=url, title="Good Doc", content="Real content")

        def failing_fetch(_url):
            # Thread A caches the Page while Thread B is fetching
            cache._URL_CACHE[url] = existing_page
            raise ConnectionError("Network down")

        monkeypatch.setattr(
            "strands_mcp_server.utils.doc_fetcher.fetch_and_clean",
            failing_fetch,
        )

        # Thread B's ensure_page should return None (failure) but NOT clobber the cache
        result = cache.ensure_page(url)
        assert result is None

        # The cache must still hold Thread A's Page, not a _FailedEntry
        cached = cache._URL_CACHE.get(url)
        assert cached is existing_page, (
            f"Expected the cached Page to remain; got {type(cached).__name__}. "
            "The failure path clobbered a good Page with a _FailedEntry."
        )


class TestRaceConditionSuccessOverwritesSentinel:
    """Regression: a successful fetch must overwrite a _FailedEntry that lands mid-fetch.

    Scenario: Thread A starts fetching (cache is None). Thread B fails and writes a
    _FailedEntry while Thread A is still fetching. Thread A's fetch succeeds. Thread A
    must overwrite the sentinel with the real Page, not short-circuit because `existing
    is not None`.
    """

    @pytest.fixture(autouse=True)
    def reset_cache_state(self):
        """Reset cache module global state before each test."""
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False
        yield
        cache._INDEX = None
        cache._URL_CACHE = {}
        cache._URL_TITLES = {}
        cache._LINKS_LOADED = False
        cache._PREFETCH_STARTED = False

    def test_success_overwrites_failed_entry_sentinel(self, monkeypatch):
        """A successful fetch must overwrite a _FailedEntry injected mid-fetch.

        Simulates: Thread A reads cache (None), starts fetch. Thread B fails and
        writes a fresh _FailedEntry during A's fetch. Thread A's fetch succeeds.
        The success path must detect the sentinel and overwrite it with the Page.

        Pre-fix bug: the guard was `if existing is not None:` which short-circuits
        when existing is a _FailedEntry, returning the sentinel → AttributeError
        when the caller accesses .content/.title.
        """
        from strands_mcp_server.utils import doc_fetcher

        url = "https://strandsagents.com/recovered.md"

        # Seed the cache with None so the top-of-function check falls through and fetch starts
        cache._URL_CACHE[url] = None

        # Index is required for ensure_page to proceed
        cache._INDEX = indexer.IndexSearch()
        cache._INDEX.add(indexer.Doc(uri=url, display_title="Recovered Doc", content="", index_title="recovered doc"))

        # fetch_and_clean injects a fresh _FailedEntry BEFORE returning success,
        # simulating another thread's failure landing while this thread was fetching
        def successful_fetch_with_race(_url):
            # Another thread's failure lands while we're fetching
            cache._URL_CACHE[url] = cache._FailedEntry()
            # This thread's fetch succeeds
            return type("Raw", (), {"title": "Recovered Doc", "content": "Fresh content"})()

        monkeypatch.setattr(
            "strands_mcp_server.utils.doc_fetcher.fetch_and_clean",
            successful_fetch_with_race,
        )
        monkeypatch.setattr(
            "strands_mcp_server.utils.cache.text_processor.format_display_title",
            lambda u, t, c: t,
        )

        result = cache.ensure_page(url)

        # The return value must be the Page, not the sentinel
        assert isinstance(result, doc_fetcher.Page), (
            f"Expected Page return; got {type(result).__name__}. "
            "The success path short-circuited on the mid-fetch _FailedEntry."
        )
        assert result.content == "Fresh content"

        # The cache must now hold the Page, not the sentinel
        cached = cache._URL_CACHE.get(url)
        assert isinstance(cached, doc_fetcher.Page), (
            f"Expected cached Page; got {type(cached).__name__}. "
            "The success path did not overwrite the mid-fetch _FailedEntry."
        )
