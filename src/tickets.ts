export interface Ticket {
  id: string;
  status: 'todo' | 'done' | 'blocked';
  title: string;
  description: string;
  ac: string[];
  blockedReason?: string;
}

export function parseTickets(markdown: string): Ticket[] {
  const tickets: Ticket[] = [];
  const ticketRegex = /## \[( |x|X)\] (t-\d+[a-z]*): (.*)/g;
  
  let match;
  let lastIndex = 0;
  let lastTicket: Partial<Ticket> | null = null;
  let lastContentStart = 0;

  // Split by ticket headers
  const lines = markdown.split('\n');
  
  let currentTicket: any = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^## \[( |x|X)\] (t-\d+[a-z]*): (.*)/);
    if (headerMatch) {
      if (currentTicket) {
        currentTicket.rawContent = currentContent.join('\n');
        tickets.push(processTicketContent(currentTicket));
      }
      currentTicket = {
        status: headerMatch[1].trim().toLowerCase() === 'x' ? 'done' : 'todo',
        id: headerMatch[2],
        title: headerMatch[3],
      };
      currentContent = [];
    } else if (currentTicket) {
      currentContent.push(line);
    }
  }

  if (currentTicket) {
    currentTicket.rawContent = currentContent.join('\n');
    tickets.push(processTicketContent(currentTicket));
  }

  return tickets;
}

function processTicketContent(ticket: any): Ticket {
  const content = ticket.rawContent as string;
  const acSplit = content.split(/^AC:$/m);
  let description = acSplit[0].trim();
  
  let blockedReason;
  const blockedMatch = description.match(/^blocked: (.*)$/m);
  if (blockedMatch) {
    blockedReason = blockedMatch[1];
    ticket.status = 'blocked';
    description = description.replace(blockedMatch[0], '').trim();
  }

  const acLines = acSplit.length > 1 ? acSplit[1].trim().split('\n') : [];
  const ac = acLines
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.substring(2).trim());

  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    description,
    ac,
    blockedReason
  };
}

export function generateTicketsMarkdown(title: string, tickets: Ticket[]): string {
  let md = `# ${title}\n\n`;
  for (const t of tickets) {
    const check = t.status === 'done' ? 'x' : ' ';
    md += `## [${check}] ${t.id}: ${t.title}\n\n`;
    if (t.status === 'blocked' && t.blockedReason) {
      md += `blocked: ${t.blockedReason}\n\n`;
    }
    if (t.description) {
      md += `${t.description}\n\n`;
    }
    if (t.ac && t.ac.length > 0) {
      md += `AC:\n`;
      for (const item of t.ac) {
        md += `- ${item}\n`;
      }
      md += `\n`;
    }
  }
  return md.trim() + '\n';
}
