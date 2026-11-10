import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

export const updateCanvasTool = tool({
  name: 'update_canvas',
  description: 'Update the style and content of the canvas element on the page',
  inputSchema: z.object({
    html: z.string().optional().describe('HTML content to set as innerHTML of the canvas body element'),
    style: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'JSON object containing CSS properties to apply to the canvas body element (e.g. {"backgroundColor": "red", "fontSize": "20px"})'
      ),
    script: z.string().optional().describe('JavaScript code to execute in the canvas iframe'),
  }),
  callback: (input): string => {
    const canvas = document.getElementById('canvas') as HTMLIFrameElement
    if (!canvas || !canvas.contentWindow) {
      throw new Error('Canvas iframe not found')
    }

    const updates: string[] = []
    const doc = canvas.contentDocument || canvas.contentWindow.document
    const body = doc.body

    if (input.html) {
      body.innerHTML = input.html
      updates.push('html updated')
    }

    if (input.style) {
      Object.assign(body.style, input.style)
      updates.push('style updated')
    }

    if (input.script) {
      canvas.contentWindow.eval(input.script)
      updates.push('script executed')
    }

    if (updates.length === 0) {
      return 'No changes made.'
    }

    return `Canvas updated: ${updates.join(', ')}`
  },
})
