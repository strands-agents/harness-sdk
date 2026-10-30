/**
 * Produces embedding vectors from text for vector search strategies. Provider-agnostic: extend
 * it to plug in any model, or use a vended implementation such as `BedrockEmbedder`.
 */
export abstract class Embedder {
  /**
   * Embeds one text. The vector length must match the dimension of the index it is stored in.
   *
   * @param text - The text to embed
   * @returns The embedding vector
   */
  abstract embed(text: string): Promise<number[]>
}
