import { Agent, StructuredOutputError, tool } from '@strands-agents/sdk'
import { z } from 'zod'

// --8<-- [start:basic_usage]
const PersonSchema = z.object({
  name: z.string().describe('Name of the person'),
  age: z.number().describe('Age of the person'),
  occupation: z.string().describe('Occupation of the person'),
})

type Person = z.infer<typeof PersonSchema>

const agent = new Agent({
  structuredOutputSchema: PersonSchema,
})

const result = await agent.invoke('John Smith is a 30 year-old software engineer')

const person = result.structuredOutput as Person
console.log(JSON.stringify(person, null, 2))
// --8<-- [end:basic_usage]

async function errorHandling() {
  // --8<-- [start:error_handling]
  try {
    const result = await agent.invoke('some prompt')
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      console.log(`Structured output failed: ${error.message}`)
    }
  }
  // --8<-- [end:error_handling]
}

async function autoRetries() {
  // --8<-- [start:auto_retries]
  const NameSchema = z.object({
    firstName: z.string().refine((val) => val.endsWith('abc'), {
      message: "You must append 'abc' to the end of my name",
    }),
  })

  const agent = new Agent({ structuredOutputSchema: NameSchema })
  const result = await agent.invoke("What is Aaron's name?")
  // --8<-- [end:auto_retries]
}

async function streamingStructuredOutput() {
  // --8<-- [start:streaming]
  const WeatherForecastSchema = z.object({
    location: z.string(),
    temperature: z.number(),
    condition: z.string(),
    humidity: z.number(),
    windSpeed: z.number(),
    forecastDate: z.string(),
  })

  type WeatherForecast = z.infer<typeof WeatherForecastSchema>

  const agent = new Agent({ structuredOutputSchema: WeatherForecastSchema })

  for await (const event of agent.stream(
    'Generate a weather forecast for Seattle: 68°F, partly cloudy, 55% humidity, 8 mph winds, for tomorrow'
  )) {
    if (event.type === 'agentResultEvent') {
      const forecast = event.result.structuredOutput as WeatherForecast
      console.log(`The forecast is: ${JSON.stringify(forecast)}`)
    }
  }
  // --8<-- [end:streaming]
}

async function combiningWithTools() {
  // --8<-- [start:combining_tools]
  const calculatorTool = tool({
    name: 'calculator',
    description: 'Perform basic arithmetic operations',
    inputSchema: z.object({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      a: z.number(),
      b: z.number(),
    }),
    callback: (input) => {
      const ops = {
        add: input.a + input.b,
        subtract: input.a - input.b,
        multiply: input.a * input.b,
        divide: input.a / input.b,
      }
      return ops[input.operation]
    },
  })

  const MathResultSchema = z.object({
    operation: z.string().describe('the performed operation'),
    result: z.number().describe('the result of the operation'),
  })

  const agent = new Agent({
    tools: [calculatorTool],
    structuredOutputSchema: MathResultSchema,
  })
  const result = await agent.invoke('What is 42 + 8')
  // --8<-- [end:combining_tools]
}

async function multipleOutputTypes() {
  // --8<-- [start:multiple_types]
  const PersonSchema = z.object({
    name: z.string().describe('Full name'),
    age: z.number().min(0).max(150).describe('Age in years'),
    email: z.string().email().describe('Email address'),
    phone: z.string().optional().describe('Phone number'),
  })

  const TaskSchema = z.object({
    title: z.string().describe('Task title'),
    description: z.string().describe('Detailed description'),
    priority: z.enum(['low', 'medium', 'high']).describe('Priority level'),
    completed: z.boolean().default(false).describe('Whether task is completed'),
  })

  type Person = z.infer<typeof PersonSchema>
  type Task = z.infer<typeof TaskSchema>

  const personAgent = new Agent({ structuredOutputSchema: PersonSchema })
  const taskAgent = new Agent({ structuredOutputSchema: TaskSchema })

  const personResult = await personAgent.invoke(
    'Extract person: John Doe, 35, john@test.com'
  )
  const taskResult = await taskAgent.invoke(
    'Create task: Review code, high priority, completed'
  )
  // --8<-- [end:multiple_types]
}

async function conversationHistory() {
  // --8<-- [start:conversation_history]
  const CityInfoSchema = z.object({
    city: z.string(),
    country: z.string(),
    population: z.number().optional(),
    climate: z.string(),
  })

  type CityInfo = z.infer<typeof CityInfoSchema>

  const agent = new Agent({ structuredOutputSchema: CityInfoSchema })

  // Build up conversation context
  await agent.invoke('What do you know about Paris, France?')
  await agent.invoke('Tell me about the weather there in spring.')

  // Extract structured information from the conversation
  const result = await agent.invoke(
    'Extract structured information about Paris from our conversation'
  )

  const cityInfo = result.structuredOutput as CityInfo
  console.log(`City: ${cityInfo.city}`) // "Paris"
  console.log(`Country: ${cityInfo.country}`) // "France"
  // --8<-- [end:conversation_history]
}

async function agentLevelDefaults() {
  // --8<-- [start:agent_defaults]
  const PersonSchema = z.object({
    name: z.string(),
    age: z.number(),
    occupation: z.string(),
  })

  type Person = z.infer<typeof PersonSchema>

  // Set default structured output schema for all invocations
  const agent = new Agent({ structuredOutputSchema: PersonSchema })
  const result = await agent.invoke('John Smith is a 30 year-old software engineer')

  const person = result.structuredOutput as Person
  console.log(`Name: ${person.name}`) // "John Smith"
  console.log(`Age: ${person.age}`) // 30
  console.log(`Job: ${person.occupation}`) // "software engineer"
  // --8<-- [end:agent_defaults]
}

async function overridingDefaults() {
  // --8<-- [start:overriding_defaults]
  const PersonSchema = z.object({
    name: z.string(),
    age: z.number(),
    occupation: z.string(),
  })

  const CompanySchema = z.object({
    name: z.string(),
    industry: z.string(),
    employees: z.number(),
  })

  type Company = z.infer<typeof CompanySchema>

  // Agent with default PersonInfo schema
  const personAgent = new Agent({ structuredOutputSchema: PersonSchema })

  // Create a new agent with CompanyInfo schema for this specific use case
  const companyAgent = new Agent({ structuredOutputSchema: CompanySchema })
  const result = await companyAgent.invoke(
    'TechCorp is a software company with 500 employees'
  )

  const company = result.structuredOutput as Company
  console.log(`Company: ${company.name}`) // "TechCorp"
  console.log(`Industry: ${company.industry}`) // "software"
  console.log(`Size: ${company.employees}`) // 500
  // --8<-- [end:overriding_defaults]
}
