import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

/**
 * Files that use the :material-language-python: / :material-language-typescript: card pattern.
 * Each entry maps a file path to its card titles.
 */
const LANGUAGE_INDEX_FILES: Array<{
  path: string;
  pythonTitle: string;
  typescriptTitle: string;
}> = [
  {
    path: "src/content/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/index.mdx",
    pythonTitle: "Python Deployment",
    typescriptTitle: "TypeScript Deployment",
  },
  {
    path: "src/content/docs/user-guide/sdk/deploy/deploy_to_docker/index.mdx",
    pythonTitle: "Python Deployment",
    typescriptTitle: "TypeScript Deployment",
  },
];

const STARLIGHT_IMPORT = `import { LinkCard, CardGrid } from '@astrojs/starlight/components';`;

/**
 * Convert :material-language-*: card sections into Starlight LinkCard/CardGrid components.
 *
 * Input pattern (repeated for python + typescript):
 *   ## :material-language-python: **Python Deployment**
 *
 *   Description text
 *
 *   [**→ Link text**](url)
 *
 *   ---
 *
 * Output:
 *   <CardGrid>
 *   <LinkCard title="Python Deployment" description="Description text" href="url" />
 *   <LinkCard title="TypeScript Deployment" description="Description text" href="url" />
 *   </CardGrid>
 */
function convertLanguageCards(content: string, pythonTitle: string, typescriptTitle: string): string {
  let result = content;

  // Build a regex that captures: heading icon, description, and link href
  // Pattern: ## :material-language-{lang}: **Title**\n\nDescription\n\n[**→ ...**](href)\n\n---\n
  const cardPattern =
    /## :material-language-python: \*\*[^*]+\*\*\n\n([^\n]+)\n\n\[\*\*→ [^\]]+\]\(([^)]+)\)\n\n---\n\n## :material-language-typescript: \*\*[^*]+\*\*\n\n([^\n]+)\n\n\[\*\*→ [^\]]+\]\(([^)]+)\)\n\n---\n/;

  const normalizeHref = (href: string) => href.replace(/\.md$/, "/");

  result = result.replace(cardPattern, (_match, pyDesc, pyHref, tsDesc, tsHref) => {
    return `<CardGrid>
<LinkCard
  title="${pythonTitle}"
  description="${pyDesc}"
  href="${normalizeHref(pyHref)}"
/>
<LinkCard
  title="${typescriptTitle}"
  description="${tsDesc}"
  href="${normalizeHref(tsHref)}"
/>
</CardGrid>

`;
  });

  return result;
}

export async function updateLanguageIndexFiles(): Promise<void> {
  for (const { path, pythonTitle, typescriptTitle } of LANGUAGE_INDEX_FILES) {
    if (!existsSync(path)) {
      console.log(`⊘ Skipped (not found): ${path}`);
      continue;
    }

    const content = await readFile(path, "utf-8");

    // Already converted
    if (content.includes(STARLIGHT_IMPORT) || content.includes("<CardGrid>")) {
      console.log(`✓ Language index already converted: ${path}`);
      continue;
    }

    let newContent = convertLanguageCards(content, pythonTitle, typescriptTitle);

    if (newContent === content) {
      console.log(`⊘ No language card pattern found: ${path}`);
      continue;
    }

    // Inject the Starlight import after frontmatter
    const frontmatterMatch = newContent.match(/^---\n[\s\S]*?\n---\n/);
    if (frontmatterMatch) {
      const insertPos = frontmatterMatch[0].length;
      newContent = newContent.slice(0, insertPos) + "\n" + STARLIGHT_IMPORT + "\n" + newContent.slice(insertPos);
    } else {
      newContent = STARLIGHT_IMPORT + "\n\n" + newContent;
    }

    await writeFile(path, newContent, "utf-8");
    console.log(`✓ Converted language index cards: ${path}`);
  }
}

// Allow running standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  updateLanguageIndexFiles().catch(console.error);
}
