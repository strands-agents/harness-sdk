import { getCollection } from 'astro:content'
import { toCardModel, sortEntries, type CatalogCardModel, type CatalogStatsFile } from './catalog'
import statsFile from '../data/catalog-stats.json'

/** Every catalog entry as a card model, in display order. Build-time only (reads the content collection). */
export async function loadCatalogCards(): Promise<CatalogCardModel[]> {
  const stats = statsFile as CatalogStatsFile
  const entries = await getCollection('catalog')
  const buildDate = new Date()
  return sortEntries(entries.map((e) => toCardModel(e.id, e.data, stats[e.id], buildDate)))
}
