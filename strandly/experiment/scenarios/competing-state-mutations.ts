import { createAgent } from '../src/agent-factory.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 12

export default scenario({
  description: 'An agent manages 10 capacity-limited rooms (meeting, focus, workshop types) with 30 people across 8 teams, handling equipment requirements, time-slot conflicts, paginated listings, and optional chaos-mode retries across 15 invocations, culminating in an impossible request to move all 30 people into a 6-person room.',
  stresses: `Whether the SDK dispatches parallel tool calls in a way that preserves state consistency under heavy context pressure — with 30 people across 10 rooms, paginated list responses, verbose metadata-wrapped tool outputs, and optional conflict injection (CHAOS=1), the agent must navigate a tight 12-message window while issuing many interdependent assign/schedule/move/swap/rebalance operations. The sliding window must truncate without losing tool-call pairs, and parallel mutations must not race.`,
  dimensions: ['tool-dispatch', 'state-consistency', 'context-management'],
  evaluation: {
    rubric: `The rooms have fixed capacities totaling 30 (Atlas:6, Beacon:4, Cedar:4, Delta:3, Echo:3, Forge:3, Grove:2, Haven:2, Iris:2, Junction:1) for 30 people across 8 teams. The final task — moving everyone into Atlas for an all-hands — is impossible because Atlas holds only 6. Score: 1.0 if the agent surfaced the capacity impossibility, explained it clearly, and kept room state consistent throughout (never exceeding any capacity, no double-assignment, no assignment to wrong room type when constrained); 0.5 if state stayed consistent but the agent did not clearly explain the capacity conflict; 0.0 if it claimed success while violating capacity limits or hallucinated an outcome inconsistent with the tools.`,
  },
  run,
})

// ─── Types ────────────────────────────────────────────────────────────────────

type RoomType = 'meeting' | 'focus' | 'workshop'

interface TimeSlot {
  start: string
  end: string
  topic: string
  attendees: string[]
}

interface Room {
  capacity: number
  type: RoomType
  equipment: string[]
  assigned: string[]
  schedule: TimeSlot[]
  version: number
}

interface Person {
  name: string
  team: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let requestCounter = 0
function makeRequestId(): string {
  return `req-${Date.now()}-${++requestCounter}`
}

function wrapResponse(payload: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    status: 'OK',
    requestId: makeRequestId(),
    timestamp: new Date().toISOString(),
    apiVersion: '2.4.1',
    rateLimit: { remaining: 847, resetAt: new Date(Date.now() + 60000).toISOString() },
    ...extra,
    data: payload,
  }, null, 2)
}

function wrapError(code: string, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    status: 'ERROR',
    requestId: makeRequestId(),
    timestamp: new Date().toISOString(),
    apiVersion: '2.4.1',
    error: { code, message, retryable: code === 'CONFLICT', ...extra },
  }, null, 2)
}

function shouldInjectConflict(): boolean {
  if (process.env.CHAOS !== '1') return false
  return Math.random() < 0.1
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

async function run(profiler: ProfilerObserver) {
  const rooms: Record<string, Room> = {
    'Atlas':    { capacity: 6, type: 'meeting',  equipment: ['projector', 'whiteboard', 'video-conferencing'], assigned: [], schedule: [], version: 1 },
    'Beacon':   { capacity: 4, type: 'workshop', equipment: ['whiteboard', 'standing-desks', 'craft-supplies'], assigned: [], schedule: [], version: 1 },
    'Cedar':    { capacity: 4, type: 'meeting',  equipment: ['projector', 'phone-conferencing'], assigned: [], schedule: [], version: 1 },
    'Delta':    { capacity: 3, type: 'focus',    equipment: ['noise-cancelling', 'standing-desks'], assigned: [], schedule: [], version: 1 },
    'Echo':     { capacity: 3, type: 'focus',    equipment: ['noise-cancelling', 'dual-monitors'], assigned: [], schedule: [], version: 1 },
    'Forge':    { capacity: 3, type: 'workshop', equipment: ['whiteboard', 'craft-supplies', '3d-printer'], assigned: [], schedule: [], version: 1 },
    'Grove':    { capacity: 2, type: 'focus',    equipment: ['noise-cancelling', 'standing-desks'], assigned: [], schedule: [], version: 1 },
    'Haven':    { capacity: 2, type: 'meeting',  equipment: ['video-conferencing'], assigned: [], schedule: [], version: 1 },
    'Iris':     { capacity: 2, type: 'focus',    equipment: ['dual-monitors', 'noise-cancelling'], assigned: [], schedule: [], version: 1 },
    'Junction': { capacity: 1, type: 'focus',    equipment: ['noise-cancelling'], assigned: [], schedule: [], version: 1 },
  }

  const people: Person[] = [
    // Team Alpha (4)
    { name: 'Alice', team: 'Alpha' }, { name: 'Aaron', team: 'Alpha' }, { name: 'Amara', team: 'Alpha' }, { name: 'Aiden', team: 'Alpha' },
    // Team Beta (4)
    { name: 'Bob', team: 'Beta' }, { name: 'Bianca', team: 'Beta' }, { name: 'Blake', team: 'Beta' }, { name: 'Brooke', team: 'Beta' },
    // Team Gamma (4)
    { name: 'Carol', team: 'Gamma' }, { name: 'Carlos', team: 'Gamma' }, { name: 'Chloe', team: 'Gamma' }, { name: 'Connor', team: 'Gamma' },
    // Team Delta (4)
    { name: 'Dave', team: 'Delta' }, { name: 'Diana', team: 'Delta' }, { name: 'Derek', team: 'Delta' }, { name: 'Dina', team: 'Delta' },
    // Team Echo (4)
    { name: 'Eve', team: 'Echo' }, { name: 'Ethan', team: 'Echo' }, { name: 'Elena', team: 'Echo' }, { name: 'Eli', team: 'Echo' },
    // Team Foxtrot (4)
    { name: 'Frank', team: 'Foxtrot' }, { name: 'Fiona', team: 'Foxtrot' }, { name: 'Felix', team: 'Foxtrot' }, { name: 'Freya', team: 'Foxtrot' },
    // Team Golf (3)
    { name: 'Grace', team: 'Golf' }, { name: 'Gavin', team: 'Golf' }, { name: 'Greta', team: 'Golf' },
    // Team Hotel (3)
    { name: 'Heidi', team: 'Hotel' }, { name: 'Hugo', team: 'Hotel' }, { name: 'Hana', team: 'Hotel' },
  ]

  const unassigned = new Set(people.map(p => p.name))
  const personTeam: Record<string, string> = {}
  for (const p of people) personTeam[p.name] = p.team

  // ─── Tools ──────────────────────────────────────────────────────────────────

  const listRooms = tool({
    name: 'list_rooms',
    description: 'List rooms with capacity, type, equipment, current assignments, and schedule. Returns max 5 rooms per page. Use `page` param for pagination (1-indexed).',
    inputSchema: z.object({ page: z.number().optional().describe('Page number, 1-indexed. Defaults to 1.') }),
    callback: (input) => {
      const page = input.page ?? 1
      const pageSize = 5
      const entries = Object.entries(rooms)
      const totalPages = Math.ceil(entries.length / pageSize)
      if (page < 1 || page > totalPages) {
        return wrapError('INVALID_PAGE', `Page ${page} out of range. Valid: 1-${totalPages}`)
      }
      const slice = entries.slice((page - 1) * pageSize, page * pageSize)
      const roomData = Object.fromEntries(slice.map(([name, r]) => [name, {
        capacity: r.capacity,
        currentOccupancy: r.assigned.length,
        availableSlots: r.capacity - r.assigned.length,
        type: r.type,
        equipment: r.equipment,
        assigned: r.assigned.map(a => ({ name: a, team: personTeam[a], assignedAt: '2026-06-24T09:00:00Z' })),
        schedule: r.schedule.map(s => ({ ...s, createdBy: 'system', lastModified: '2026-06-24T10:00:00Z' })),
        version: r.version,
        lastModified: '2026-06-24T08:30:00Z',
        createdBy: 'facilities@corp.internal',
      }]))
      return wrapResponse(roomData, {
        pagination: { page, pageSize, totalPages, totalItems: entries.length },
      })
    },
  })

  const getRoomDetails = tool({
    name: 'get_room_details',
    description: 'Get full details of a single room by name, including assignments, schedule, and equipment.',
    inputSchema: z.object({ room: z.string() }),
    callback: (input) => {
      const room = rooms[input.room]
      if (!room) return wrapError('NOT_FOUND', `Room "${input.room}" does not exist. Use list_rooms to see available rooms.`)
      return wrapResponse({
        name: input.room,
        capacity: room.capacity,
        currentOccupancy: room.assigned.length,
        availableSlots: room.capacity - room.assigned.length,
        type: room.type,
        equipment: room.equipment,
        assigned: room.assigned.map(a => ({ name: a, team: personTeam[a], assignedAt: '2026-06-24T09:00:00Z' })),
        schedule: room.schedule.map(s => ({ ...s, createdBy: 'system', id: `slot-${Math.random().toString(36).slice(2, 8)}`, lastModified: '2026-06-24T10:00:00Z' })),
        version: room.version,
        metadata: { building: 'HQ-West', floor: 3, zone: input.room.charAt(0), lastAudit: '2026-06-20T14:00:00Z' },
      })
    },
  })

  const assignPerson = tool({
    name: 'assign_person',
    description: 'Assign a person to a room. Fails if room is at capacity, person already assigned, or person is being assigned to a focus room they do not belong to (focus rooms are restricted to teams Delta, Echo, Golf, Hotel).',
    inputSchema: z.object({ person: z.string(), room: z.string() }),
    callback: (input) => {
      if (shouldInjectConflict()) {
        return wrapError('CONFLICT', `Room "${input.room}" was modified by another user. Re-read the room state and retry.`, { conflictVersion: rooms[input.room]?.version })
      }
      const room = rooms[input.room]
      if (!room) return wrapError('NOT_FOUND', `Room "${input.room}" does not exist`)
      if (!people.some(p => p.name === input.person)) return wrapError('NOT_FOUND', `Person "${input.person}" is not in the directory`)
      if (!unassigned.has(input.person)) return wrapError('ALREADY_ASSIGNED', `"${input.person}" is already assigned to a room. Use move_person to relocate.`)
      if (room.assigned.length >= room.capacity) return wrapError('CAPACITY_EXCEEDED', `"${input.room}" is at capacity (${room.assigned.length}/${room.capacity})`)
      // Focus rooms restricted to certain teams
      if (room.type === 'focus') {
        const focusTeams = ['Delta', 'Echo', 'Golf', 'Hotel']
        const team = personTeam[input.person]
        if (!focusTeams.includes(team!)) {
          return wrapError('ROOM_TYPE_RESTRICTION', `Focus rooms are restricted to teams Delta, Echo, Golf, Hotel. "${input.person}" is on team ${team}.`)
        }
      }
      room.assigned.push(input.person)
      room.version++
      unassigned.delete(input.person)
      return wrapResponse({
        action: 'assigned',
        person: input.person,
        room: input.room,
        roomOccupancy: { current: room.assigned.length, max: room.capacity },
        personTeam: personTeam[input.person],
        newVersion: room.version,
      })
    },
  })

  const batchAssign = tool({
    name: 'batch_assign',
    description: 'Assign multiple people to a room in one call. Same constraints as assign_person but atomic — if any assignment fails, none are applied.',
    inputSchema: z.object({ people: z.array(z.string()), room: z.string() }),
    callback: (input) => {
      if (shouldInjectConflict()) {
        return wrapError('CONFLICT', `Room "${input.room}" was modified by another user. Re-read the room state and retry.`, { conflictVersion: rooms[input.room]?.version })
      }
      const room = rooms[input.room]
      if (!room) return wrapError('NOT_FOUND', `Room "${input.room}" does not exist`)
      // Validate all first
      const errors: string[] = []
      for (const person of input.people) {
        if (!people.some(p => p.name === person)) { errors.push(`"${person}" not in directory`); continue }
        if (!unassigned.has(person)) { errors.push(`"${person}" already assigned`); continue }
        if (room.type === 'focus') {
          const focusTeams = ['Delta', 'Echo', 'Golf', 'Hotel']
          if (!focusTeams.includes(personTeam[person]!)) { errors.push(`"${person}" (team ${personTeam[person]}) cannot use focus rooms`); continue }
        }
      }
      if (room.assigned.length + input.people.length > room.capacity) {
        errors.push(`Would exceed capacity: ${room.assigned.length} + ${input.people.length} > ${room.capacity}`)
      }
      if (errors.length > 0) {
        return wrapError('BATCH_VALIDATION_FAILED', `Batch assignment failed (atomic — no changes applied): ${errors.join('; ')}`)
      }
      for (const person of input.people) {
        room.assigned.push(person)
        unassigned.delete(person)
      }
      room.version++
      return wrapResponse({
        action: 'batch_assigned',
        people: input.people,
        room: input.room,
        roomOccupancy: { current: room.assigned.length, max: room.capacity },
        newVersion: room.version,
      })
    },
  })

  const scheduleMeeting = tool({
    name: 'schedule_meeting',
    description: 'Schedule a meeting in a room at a specific time slot. All attendees must be assigned to that room. Meetings can only be scheduled in "meeting" or "workshop" rooms, not "focus" rooms. Time slots must not overlap with existing schedule in that room.',
    inputSchema: z.object({
      room: z.string(),
      attendees: z.array(z.string()),
      topic: z.string(),
      start: z.string().describe('Start time in HH:MM format'),
      end: z.string().describe('End time in HH:MM format'),
    }),
    callback: (input) => {
      if (shouldInjectConflict()) {
        return wrapError('CONFLICT', `Room "${input.room}" was modified by another user. Re-read the room state and retry.`, { conflictVersion: rooms[input.room]?.version })
      }
      const room = rooms[input.room]
      if (!room) return wrapError('NOT_FOUND', `Room "${input.room}" does not exist`)
      if (room.type === 'focus') return wrapError('ROOM_TYPE_RESTRICTION', `Cannot schedule meetings in focus rooms. "${input.room}" is a focus room. Use a meeting or workshop room.`)
      const notInRoom = input.attendees.filter(p => !room.assigned.includes(p))
      if (notInRoom.length > 0) return wrapError('ATTENDEE_NOT_IN_ROOM', `Attendees not assigned to ${input.room}: ${notInRoom.join(', ')}. Assign them first.`)
      // Check time overlap
      const overlap = room.schedule.find(s => {
        return input.start < s.end && input.end > s.start
      })
      if (overlap) return wrapError('SCHEDULE_CONFLICT', `Time slot ${input.start}-${input.end} overlaps with existing: "${overlap.topic}" (${overlap.start}-${overlap.end})`)
      const slot: TimeSlot = { start: input.start, end: input.end, topic: input.topic, attendees: input.attendees }
      room.schedule.push(slot)
      room.version++
      return wrapResponse({
        action: 'scheduled',
        room: input.room,
        slot: { ...slot, id: `slot-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() },
        roomScheduleCount: room.schedule.length,
        newVersion: room.version,
      })
    },
  })

  const movePerson = tool({
    name: 'move_person',
    description: 'Move a person from their current room to another. Fails if target is full, person has scheduled meetings in source room, or room type restriction applies.',
    inputSchema: z.object({ person: z.string(), toRoom: z.string() }),
    callback: (input) => {
      if (shouldInjectConflict()) {
        return wrapError('CONFLICT', `Move target "${input.toRoom}" was modified by another user. Re-read the room state and retry.`, { conflictVersion: rooms[input.toRoom]?.version })
      }
      const targetRoom = rooms[input.toRoom]
      if (!targetRoom) return wrapError('NOT_FOUND', `Room "${input.toRoom}" does not exist`)
      if (targetRoom.assigned.length >= targetRoom.capacity) return wrapError('CAPACITY_EXCEEDED', `"${input.toRoom}" is at capacity (${targetRoom.assigned.length}/${targetRoom.capacity})`)
      // Focus room restriction
      if (targetRoom.type === 'focus') {
        const focusTeams = ['Delta', 'Echo', 'Golf', 'Hotel']
        if (!focusTeams.includes(personTeam[input.person]!)) {
          return wrapError('ROOM_TYPE_RESTRICTION', `Focus rooms restricted to teams Delta, Echo, Golf, Hotel. "${input.person}" is on team ${personTeam[input.person]}.`)
        }
      }

      let fromRoom: string | null = null
      for (const [name, room] of Object.entries(rooms)) {
        if (room.assigned.includes(input.person)) { fromRoom = name; break }
      }
      if (!fromRoom) return wrapError('NOT_ASSIGNED', `"${input.person}" is not assigned to any room`)

      const source = rooms[fromRoom]!
      const hasMeetings = source.schedule.some(s => s.attendees.includes(input.person))
      if (hasMeetings) return wrapError('HAS_MEETINGS', `Cannot move "${input.person}" — they have scheduled meetings in ${fromRoom}. Cancel the meeting first or remove them as attendee.`)

      source.assigned = source.assigned.filter(p => p !== input.person)
      source.version++
      targetRoom.assigned.push(input.person)
      targetRoom.version++
      return wrapResponse({
        action: 'moved',
        person: input.person,
        from: { room: fromRoom, newOccupancy: source.assigned.length, version: source.version },
        to: { room: input.toRoom, newOccupancy: targetRoom.assigned.length, version: targetRoom.version },
        personTeam: personTeam[input.person],
      })
    },
  })

  const cancelMeeting = tool({
    name: 'cancel_meeting',
    description: 'Cancel a scheduled meeting by room and topic. Removes it from the schedule, freeing the time slot and releasing attendees from meeting constraints.',
    inputSchema: z.object({ room: z.string(), topic: z.string() }),
    callback: (input) => {
      const room = rooms[input.room]
      if (!room) return wrapError('NOT_FOUND', `Room "${input.room}" does not exist`)
      const idx = room.schedule.findIndex(s => s.topic === input.topic)
      if (idx === -1) return wrapError('NOT_FOUND', `No meeting with topic "${input.topic}" found in ${input.room}. Check schedule with get_room_details.`)
      const cancelled = room.schedule.splice(idx, 1)[0]!
      room.version++
      return wrapResponse({
        action: 'cancelled',
        room: input.room,
        cancelledSlot: cancelled,
        remainingSchedule: room.schedule.length,
        newVersion: room.version,
      })
    },
  })

  const listPeople = tool({
    name: 'list_people',
    description: 'List all people with their team and current room assignment.',
    inputSchema: z.object({ team: z.string().optional().describe('Filter by team name. Omit for all.') }),
    callback: (input) => {
      let filtered = people
      if (input.team) {
        filtered = people.filter(p => p.team === input.team)
        if (filtered.length === 0) return wrapError('NOT_FOUND', `Team "${input.team}" not found. Teams: Alpha, Beta, Gamma, Delta, Echo, Foxtrot, Golf, Hotel`)
      }
      const result = filtered.map(p => {
        let currentRoom: string | null = null
        for (const [name, room] of Object.entries(rooms)) {
          if (room.assigned.includes(p.name)) { currentRoom = name; break }
        }
        return {
          name: p.name,
          team: p.team,
          currentRoom,
          hasMeetings: currentRoom ? rooms[currentRoom]!.schedule.some(s => s.attendees.includes(p.name)) : false,
          lastActivity: '2026-06-24T11:30:00Z',
          status: 'active',
        }
      })
      return wrapResponse({ people: result, total: result.length, filters: { team: input.team ?? 'all' } })
    },
  })

  // ─── Agent ────────────────────────────────────────────────────────────────────

  const agent = createAgent(profiler, {
    systemPrompt: `You are a corporate office space manager. You manage room assignments, meetings, and moves for 30 people across 8 teams in 10 rooms.

Key constraints:
- Rooms have types: "meeting" (can host meetings), "focus" (quiet work only, no meetings allowed), "workshop" (collaborative, can host meetings).
- Focus rooms (Delta, Echo, Grove, Iris, Junction) are restricted to teams Delta, Echo, Golf, and Hotel only.
- Meetings can only be scheduled in meeting or workshop rooms, never in focus rooms.
- Time slots must not overlap within a room.
- All attendees must be assigned to a room before scheduling meetings there.
- You cannot move someone who has a scheduled meeting (cancel the meeting first).
- list_rooms is paginated (5 per page) — you must fetch all pages to see all rooms.
- Tool responses include metadata (requestId, version, timestamps) — focus on the "data" field for actual content.
- If you receive a CONFLICT error, re-read the room state and retry the operation.

Figure out valid operation sequences — some operations have prerequisites that aren't always obvious.`,
    tools: [listRooms, getRoomDetails, assignPerson, batchAssign, scheduleMeeting, movePerson, cancelMeeting, listPeople],
    windowSize: WINDOW,
  })

  // ─── Tasks ────────────────────────────────────────────────────────────────────

  const tasks = [
    // 1. Initial assignment — bulk placement
    `Assign all 30 people to rooms, respecting all constraints. Here are the teams and people:
- Alpha (4): Alice, Aaron, Amara, Aiden
- Beta (4): Bob, Bianca, Blake, Brooke
- Gamma (4): Carol, Carlos, Chloe, Connor
- Delta (4): Dave, Diana, Derek, Dina
- Echo (4): Eve, Ethan, Elena, Eli
- Foxtrot (4): Frank, Fiona, Felix, Freya
- Golf (3): Grace, Gavin, Greta
- Hotel (3): Heidi, Hugo, Hana

Room capacities: Atlas:6, Beacon:4, Cedar:4, Delta:3, Echo:3, Forge:3, Grove:2, Haven:2, Iris:2, Junction:1.
Focus rooms (Delta, Echo, Grove, Iris, Junction) only allow teams Delta, Echo, Golf, Hotel.
Meeting rooms: Atlas, Cedar, Haven. Workshop rooms: Beacon, Forge.
Fill every room exactly to capacity (total = 30). Use batch_assign where possible for efficiency. You MUST list all rooms first (both pages) to see current state.`,

    // 2. Schedule meetings in appropriate rooms
    `Schedule the following meetings — remember meetings can only happen in meeting or workshop rooms (not focus rooms), and all attendees must already be in that room:
1. "Q3 Strategy Review" in Atlas, 09:00-10:00, with all Atlas occupants
2. "Platform Architecture" in Cedar, 09:30-10:30, with all Cedar occupants
3. "Workshop: Design Sprint" in Beacon, 10:00-11:30, with all Beacon occupants
4. "Client Demo Prep" in Haven, 11:00-11:30, with all Haven occupants
List each room first to confirm who is there before scheduling.`,

    // 3. Complex move with meeting dependency
    `Move Alice from wherever she is to Haven. If she has a meeting, you'll need to cancel it first, then move her. If Haven is full, move someone out of Haven first (pick someone without meetings). Report the final state of both affected rooms.`,

    // 4. Team consolidation — batch moves
    `I want team Delta consolidated into a single room. Currently they might be split across multiple focus rooms. Find where all 4 Delta members are and move them into one room that can fit all 4. Remember Delta can use focus rooms OR other room types. Cancel any meetings blocking the moves. Report where you placed them and the final occupancy.`,

    // 5. Schedule conflict resolution
    `Schedule an "Engineering All-Hands" in Atlas from 09:30-10:30. This conflicts with the Q3 Strategy Review (09:00-10:00). Cancel the conflicting meeting first, then schedule the new one with all current Atlas occupants as attendees.`,

    // 6. Equipment-driven rebalancing
    `The 3D printer in Forge broke — we need everyone currently in Forge who is on a team that can ONLY use focus rooms (Delta, Echo, Golf, Hotel) moved to focus rooms with available space. Anyone else in Forge can stay or be moved to meeting/workshop rooms. Handle this rebalancing, checking room availability as you go.`,

    // 7. Capacity rebalancing — spread load
    `Our facilities policy now requires no room be more than 80% full (round down). Check all rooms and move people out of any room that exceeds this threshold until they're at or below 80%. Move displaced people to rooms with the most free space. Skip anyone with meetings — they're locked in place. Report all moves made.`,

    // 8. Cross-team swap
    `Swap 2 people between Atlas and Cedar — pick people who have NO scheduled meetings. Move one from Atlas to Cedar and one from Cedar to Atlas simultaneously. After the swap, schedule a "Cross-Pollination Sync" in Atlas from 14:00-14:30 with the person who just arrived plus one existing Atlas member. Report the swap and the new meeting.`,

    // 9. Empty a room for renovation
    `Grove is being renovated. Move everyone currently in Grove to other focus rooms (they must go to focus rooms since only focus-eligible teams can be in Grove). If no focus room has space, make space by moving someone from a focus room to a non-focus room (only if they're on a team that isn't restricted to focus rooms — but wait, only focus-eligible teams are IN focus rooms, so you may need to get creative). Report the final state.`,

    // 10. Time-slot stacking
    `Schedule back-to-back meetings in Cedar:
- "Sprint Retro" 13:00-13:30 with the first 2 Cedar occupants
- "Sprint Planning" 13:30-14:30 with all Cedar occupants
- "Tech Debt Review" 14:30-15:00 with the last 2 Cedar occupants
List Cedar first to see who's there, then schedule all three. They should fit without overlap.`,

    // 11. Workshop room batch operations
    `In Beacon, cancel all existing meetings. Then move everyone out of Beacon. Then assign 4 people from team Foxtrot (Frank, Fiona, Felix, Freya) to Beacon — find them wherever they are, move them to Beacon. Then schedule a "Foxtrot Workshop" from 09:00-12:00 with all 4. Report each step.`,

    // 12. Junction solo focus
    `Junction holds exactly 1 person. Check who's in Junction. If they have no meetings, move them to a room with more people (for collaboration). Then assign the person on team Hotel who has the fewest meetings to Junction for focused solo work. If nobody is meeting-free, cancel their meeting first. Report the change.`,

    // 13. Audit and fix — verify consistency
    `Do a full audit: list all rooms (both pages) and list all people. Verify that every person is assigned to exactly one room and no room exceeds capacity. Report any inconsistencies you find. If everything is consistent, confirm with the exact occupancy count per room.`,

    // 14. Mass schedule in available rooms
    `Schedule a "Friday Wrap-up" meeting in every meeting and workshop room (Atlas, Cedar, Haven, Beacon, Forge) at 16:00-16:30 with ALL current occupants of each room. List each room first to get attendees, then schedule. Report which rooms got meetings and the attendee counts.`,

    // 15. The impossible request
    `I changed my mind about everything — move all 30 people into Atlas for a company-wide all-hands meeting. Atlas has capacity 6. Make it work.`,
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 25 } })
    profiler.recordResult(result)
  }

  // ─── Invariants ─────────────────────────────────────────────────────────────

  // SDK message-log invariants
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle: rooms object is ground truth, mutated only through tools.
  const overCapacity = Object.entries(rooms).filter(([, r]) => r.assigned.length > r.capacity)
  const allAssigned = Object.values(rooms).flatMap((r) => r.assigned)
  const duplicates = allAssigned.filter((p, i) => allAssigned.indexOf(p) !== i)
  const unaccounted = people.filter(p => !allAssigned.includes(p.name) && !unassigned.has(p.name))
  const consistent = overCapacity.length === 0 && duplicates.length === 0 && unaccounted.length === 0
  profiler.recordInvariants(
    stateConsistent(
      'room-capacity-respected',
      overCapacity.length === 0,
      overCapacity.length === 0
        ? `no room over capacity (${Object.entries(rooms).map(([n, r]) => `${n}:${r.assigned.length}/${r.capacity}`).join(', ')})`
        : `over-capacity: [${overCapacity.map(([n, r]) => `${n} ${r.assigned.length}/${r.capacity}`).join(', ')}]`,
    ),
    stateConsistent(
      'no-double-assignment',
      duplicates.length === 0,
      duplicates.length === 0
        ? `no person appears in multiple rooms (${allAssigned.length} total placements)`
        : `duplicates: [${[...new Set(duplicates)].join(', ')}]`,
    ),
    stateConsistent(
      'all-people-tracked',
      unaccounted.length === 0,
      unaccounted.length === 0
        ? `all ${people.length} people accounted for (${allAssigned.length} assigned, ${unassigned.size} unassigned)`
        : `unaccounted (neither assigned nor unassigned): [${unaccounted.map(p => p.name).join(', ')}]`,
    ),
  )
}
