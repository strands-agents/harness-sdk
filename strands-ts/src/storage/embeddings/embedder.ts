/** Options for a single {@link Embedder.embed} call. */
export interface EmbedOptions {
  /**
   * What the text is embedded for: `'document'` when indexing stored content, `'query'` when
   * searching. Models that embed the two differently (e.g. Cohere's `input_type`) use it;
   * models that do not, ignore it.
   */
  purpose?: 'document' | 'query'
}

/**
 * Produces embedding vectors from text for vector search strategies. Provider-agnostic: extend
 * it to plug in any model, or use a vended implementation such as `BedrockEmbedder`.
 */
export abstract class Embedder {
  /**
   * Embeds one text. The vector length must match the dimension of the index it is stored in.
   *
   * @param text - The text to embed
   * @param options - What the embedding is for
   * @returns The embedding vector
   */
  abstract embed(text: string, options?: EmbedOptions): Promise<number[]>
}
