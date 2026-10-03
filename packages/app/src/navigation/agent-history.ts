export interface AgentVisit {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

interface AgentHistoryOptions {
  now: () => number;
  capacity: number;
  /** How long after a ⌃Tab press the next one keeps walking the same snapshot. */
  cycleWindowMs: number;
}

interface RecentCycle {
  order: AgentVisit[];
  index: number;
  lastStepAt: number;
}

type IsVisitAvailable = (visit: AgentVisit) => boolean;

function isSameAgent(left: AgentVisit | null, right: AgentVisit | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.serverId === right.serverId &&
    left.agentId === right.agentId
  );
}

function withoutAgent(visits: readonly AgentVisit[], visit: AgentVisit): AgentVisit[] {
  return visits.filter((candidate) => !isSameAgent(candidate, visit));
}

/**
 * The agents the user has looked at, kept two ways. `back`/`forward` is a
 * browser-style history for ⌘[ / ⌘]. `recent` is a most-recently-used list for
 * ⌃Tab: presses that land within `cycleWindowMs` of each other keep walking the
 * list as it was when the first one landed, the way an app switcher does, and
 * the agent they stop on moves to the front once the window closes.
 */
export function createAgentHistory(options: AgentHistoryOptions) {
  let current: AgentVisit | null = null;
  let back: AgentVisit[] = [];
  let forward: AgentVisit[] = [];
  let recent: AgentVisit[] = [];
  let cycle: RecentCycle | null = null;

  function cap(visits: AgentVisit[]): AgentVisit[] {
    return visits.slice(-options.capacity);
  }

  function promote(visit: AgentVisit) {
    recent = [visit, ...withoutAgent(recent, visit)].slice(0, options.capacity);
  }

  function settleCycle() {
    if (!cycle) return;
    if (options.now() - cycle.lastStepAt <= options.cycleWindowMs) return;
    promote(cycle.order[cycle.index]);
    cycle = null;
  }

  function move(
    from: AgentVisit[],
    isAvailable: IsVisitAvailable,
  ): { target: AgentVisit; rest: AgentVisit[] } | null {
    const rest = [...from];
    while (rest.length > 0) {
      const target = rest.pop();
      if (target && !isSameAgent(target, current) && isAvailable(target)) {
        return { target, rest };
      }
    }
    return null;
  }

  return {
    visit(visit: AgentVisit) {
      settleCycle();
      if (cycle && !isSameAgent(visit, cycle.order[cycle.index])) {
        promote(cycle.order[cycle.index]);
        cycle = null;
      }
      if (!cycle) {
        promote(visit);
      }
      if (isSameAgent(current, visit)) {
        current = visit;
        return;
      }
      if (current) {
        back = cap([...back, current]);
      }
      forward = [];
      current = visit;
    },

    /** Steps history and returns where to go; the navigation that follows must not grow it. */
    step(delta: 1 | -1, isAvailable: IsVisitAvailable): AgentVisit | null {
      settleCycle();
      const from = delta === -1 ? back : forward;
      const moved = move(from, isAvailable);
      if (!moved) return null;
      if (delta === -1) {
        back = moved.rest;
        forward = current ? cap([...forward, current]) : forward;
      } else {
        forward = moved.rest;
        back = current ? cap([...back, current]) : back;
      }
      current = moved.target;
      return moved.target;
    },

    cycleRecent(delta: 1 | -1, isAvailable: IsVisitAvailable): AgentVisit | null {
      settleCycle();
      if (!cycle) {
        const order = recent.filter(isAvailable);
        if (current && !isSameAgent(order[0] ?? null, current)) {
          order.unshift(current);
        }
        cycle = { order: withDistinctAgents(order), index: 0, lastStepAt: 0 };
      }
      if (cycle.order.length < 2) {
        cycle = null;
        return null;
      }
      const length = cycle.order.length;
      cycle.index = (cycle.index + delta + length) % length;
      cycle.lastStepAt = options.now();
      return cycle.order[cycle.index];
    },

    recent(): AgentVisit[] {
      settleCycle();
      return [...recent];
    },
  };
}

function withDistinctAgents(visits: readonly AgentVisit[]): AgentVisit[] {
  const distinct: AgentVisit[] = [];
  for (const visit of visits) {
    if (!distinct.some((candidate) => isSameAgent(candidate, visit))) {
      distinct.push(visit);
    }
  }
  return distinct;
}
