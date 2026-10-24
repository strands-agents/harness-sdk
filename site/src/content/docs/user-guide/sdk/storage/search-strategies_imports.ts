// @ts-nocheck

// --8<-- [start:keyword_search_imports]
import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:keyword_search_imports]

// --8<-- [start:bm25_search_imports]
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:bm25_search_imports]

// --8<-- [start:s3_vector_search_imports]
import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
import { S3Storage } from '@strands-agents/sdk/storage'
// --8<-- [end:s3_vector_search_imports]

// --8<-- [start:custom_embedder_imports]
import { Embedder, S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
import type { EmbedOptions } from '@strands-agents/sdk/storage/search'
import { S3Storage } from '@strands-agents/sdk/storage'
// --8<-- [end:custom_embedder_imports]

// --8<-- [start:storage_with_strategy_imports]
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:storage_with_strategy_imports]

// --8<-- [start:custom_strategy_imports]
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import type { Storage } from '@strands-agents/sdk/storage'
import type {
  SearchStrategy,
  StorageSearchResult,
} from '@strands-agents/sdk/storage/search'
// --8<-- [end:custom_strategy_imports]
