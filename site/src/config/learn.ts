// Promote deepDives to a content collection if this list grows past ~6.

export interface DeepDive {
  title: string
  tag: string
  description: string
  href: string
  thumbnail: 'target' | 'question'
}

export const deepDives: DeepDive[] = [
  {
    title: 'How steering hooks hit 100% agent accuracy',
    tag: 'Case study · Blog',
    description: 'A production case study in constraining agent behavior — and the numbers behind the headline.',
    href: '/blog/steering-accuracy-beats-prompts-workflows/',
    thumbnail: 'target',
  },
]

export const suggestTopicHref = 'https://discord.gg/strands'
