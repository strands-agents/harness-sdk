import { Agent } from '@strands-agents/sdk'
import express, { type Request, type Response } from 'express'

async function deployReadyAgent() {
  // --8<-- [start:deploy_ready_agent]
  const agent = new Agent()
  const app = express()
  app.use(express.json())

  app.post('/invocations', async (req: Request, res: Response) => {
    const result = await agent.invoke(req.body.prompt)
    res.json({ output: result.lastMessage })
  })

  app.get('/ping', (_: Request, res: Response) => res.json({ status: 'healthy' }))

  app.listen(Number(process.env.PORT) || 8080)
  // --8<-- [end:deploy_ready_agent]
}
