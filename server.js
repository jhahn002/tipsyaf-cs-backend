// ============================================================
// TIPSY AF — Customer Service Backend Server v3
// Features: Webhooks, tickets, KB, AI drafting, smart tagging,
//           customer history, fuzzy matching, merge, threading
// Deploy to: Render.com
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';


// ============================================================
// HELPERS
// ============================================================

function generateTicketId() {
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `TIX-${num}`;
}

function generateAutoTags(purpose, message) {
  const tags = [];
  const msg = message.toLowerCase();
  const purposeTags = {
    'Billing': ['Billing inquiry'], 'Tech Support': ['Technical issue'],
    'Product Questions': ['Product inquiry'], 'Shipping & Delivery': ['Shipping issue'],
    'Returns & Refunds': ['Refund request'], 'Wholesale': ['Wholesale inquiry', 'Bulk order'],
    'Partnership': ['Partnership inquiry'], 'Press & Media': ['Press inquiry'], 'Other': ['General inquiry'],
  };
  if (purposeTags[purpose]) tags.push(...purposeTags[purpose]);
  if (msg.includes('cancel') || msg.includes('subscription')) tags.push('Subscription issue');
  if (msg.includes('refund') || msg.includes('money back')) tags.push('Refund request');
  if (msg.includes('tracking') || msg.includes('where is my order')) tags.push('Tracking question');
  if (msg.includes('flavor') || msg.includes('taste')) tags.push('Flavor feedback');
  if (msg.includes('bulk') || msg.includes('event') || msg.includes('wholesale')) tags.push('Bulk opportunity');
  if (msg.includes('love') || msg.includes('amazing') || msg.includes('obsessed')) tags.push('Positive sentiment');
  if (msg.includes('disappoint') || msg.includes('not working') || msg.includes("doesn't work")) tags.push('At risk');
  if (msg.includes('gift')) tags.push('Gift buyer');
  if (msg.includes('how long') || msg.includes('dosage') || msg.includes('how much')) tags.push('Dosage question');
  if (msg.includes('new flavor') || msg.includes('mango') || msg.includes('lemon')) tags.push('New flavor interest');
  return [...new Set(tags)];
}

function generateSummary(purpose, message, name) {
  return `${name} submitted a ${purpose.toLowerCase()} inquiry via the contact form.`;
}

function determinePriority(purpose, message) {
  const msg = message.toLowerCase();
  if (msg.includes('urgent') || msg.includes('asap') || msg.includes('immediately')) return 'urgent';
  if (purpose === 'Returns & Refunds' || msg.includes('refund') || msg.includes('cancel')) return 'high';
  if (purpose === 'Billing' || purpose === 'Shipping & Delivery') return 'high';
  if (purpose === 'Wholesale' || purpose === 'Partnership') return 'medium';
  return 'medium';
}

function generateTagsFromNote(noteContent) {
  const tags = [];
  const note = noteContent.toLowerCase();
  if (note.includes('refund') && (note.includes('gave') || note.includes('processed') || note.includes('issued') || note.includes('already'))) tags.push('Previous refund');
  if (note.includes('reshipped') || note.includes('reship') || note.includes('sent replacement')) tags.push('Previous reship');
  if (note.includes('discount') || note.includes('coupon') || note.includes('% off')) tags.push('Received discount');
  if (note.includes('dosage') && (note.includes('educated') || note.includes('explained') || note.includes('guidance'))) tags.push('Dosage education given');
  if (note.includes('vip') || note.includes('high value') || note.includes('important')) tags.push('VIP');
  if (note.includes('escalat')) tags.push('Previously escalated');
  if (note.includes('repeat') && (note.includes('issue') || note.includes('complaint') || note.includes('problem'))) tags.push('Repeat complaint');
  if (note.includes('influencer') || note.includes('social media') || note.includes('instagram') || note.includes('tiktok')) tags.push('Influencer');
  if (note.includes('wholesale') || note.includes('bulk') || note.includes('distributor')) tags.push('Wholesale lead');
  if (note.includes('subscription') && (note.includes('cancel') || note.includes('pause'))) tags.push('Subscription at risk');
  if (note.includes('happy') || note.includes('satisfied') || note.includes('resolved')) tags.push('Resolved positive');
  if (note.includes('angry') || note.includes('upset') || note.includes('frustrated')) tags.push('Difficult interaction');
  if (note.includes("didn't feel") || note.includes('no effect') || note.includes('not working')) tags.push('Effect skeptic');
  return [...new Set(tags)];
}

async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Claude API error ${response.status}: ${err}`); }
  const data = await response.json();
  return data.content[0].text;
}

async function loadKnowledgeBase() {
  const { data, error } = await supabase.from('knowledge_base').select('category, title, content').eq('is_active', true).order('priority', { ascending: false });
  if (error) { console.error('Failed to load KB:', error); return ''; }
  const sections = {};
  for (const item of data) { if (!sections[item.category]) sections[item.category] = []; sections[item.category].push(`### ${item.title}\n${item.content}`); }
  const labels = { brand_voice: 'BRAND VOICE & TONE', product: 'PRODUCT KNOWLEDGE', policy: 'POLICIES & PROCEDURES', launch: 'UPCOMING LAUNCHES & PROMOS', example_response: 'EXAMPLE RESPONSES' };
  let kb = '';
  for (const [cat, items] of Object.entries(sections)) { kb += `\n## ${labels[cat] || cat.toUpperCase()}\n\n${items.join('\n\n')}\n`; }
  return kb;
}

// ---- Fuzzy name matching helper ----
function normalizeName(name) {
  return name.toLowerCase().trim().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ');
}

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1.0;
  // Check if first/last names match in any order
  const partsA = na.split(' ');
  const partsB = nb.split(' ');
  let matches = 0;
  for (const pa of partsA) {
    for (const pb of partsB) {
      if (pa === pb && pa.length > 1) matches++;
      // Levenshtein-lite: allow 1 char difference for typos
      else if (pa.length > 3 && pb.length > 3 && Math.abs(pa.length - pb.length) <= 1) {
        let diff = 0;
        const shorter = pa.length <= pb.length ? pa : pb;
        const longer = pa.length > pb.length ? pa : pb;
        for (let i = 0; i < shorter.length; i++) { if (shorter[i] !== longer[i]) diff++; }
        if (diff <= 1) matches += 0.8;
      }
    }
  }
  const maxParts = Math.max(partsA.length, partsB.length);
  return maxParts > 0 ? matches / maxParts : 0;
}

// ---- Find or create customer with fuzzy matching ----
async function findOrCreateCustomer(email, phone, fullName) {
  // 1. Try exact email match
  const { data: byEmail } = await supabase
    .from('customers')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (byEmail) {
    // Update with latest info
    const updates = { updated_at: new Date().toISOString(), ticket_count: byEmail.ticket_count + 1 };
    if (fullName && fullName !== byEmail.name) updates.name = fullName;
    if (phone && !byEmail.phone) updates.phone = phone;
    await supabase.from('customers').update(updates).eq('id', byEmail.id);
    return { customer: byEmail, matchType: 'email', isNew: false };
  }

  // 2. Try phone match (if phone provided)
  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length >= 10) {
      // Match on last 10 digits to handle +1 prefix variations
      const phoneSuffix = cleanPhone.slice(-10);
      const { data: allCustomers } = await supabase.from('customers').select('*').not('phone', 'is', null);
      
      if (allCustomers) {
        const phoneMatch = allCustomers.find(c => {
          const cp = (c.phone || '').replace(/\D/g, '');
          return cp.slice(-10) === phoneSuffix;
        });
        
        if (phoneMatch) {
          // Update and add secondary email
          const updates = { updated_at: new Date().toISOString(), ticket_count: phoneMatch.ticket_count + 1 };
          if (!phoneMatch.alt_emails) updates.alt_emails = [email.toLowerCase()];
          else if (!phoneMatch.alt_emails.includes(email.toLowerCase())) {
            updates.alt_emails = [...phoneMatch.alt_emails, email.toLowerCase()];
          }
          await supabase.from('customers').update(updates).eq('id', phoneMatch.id);
          console.log(`📱 Phone match: ${fullName} matched to ${phoneMatch.name} via phone`);
          return { customer: phoneMatch, matchType: 'phone', isNew: false };
        }
      }
    }
  }

  // 3. Try fuzzy name match (only if name has first+last)
  const nameParts = fullName.trim().split(' ');
  if (nameParts.length >= 2) {
    const { data: allCustomers } = await supabase.from('customers').select('*');
    if (allCustomers) {
      let bestMatch = null;
      let bestScore = 0;
      for (const c of allCustomers) {
        const score = nameSimilarity(fullName, c.name);
        if (score > 0.7 && score > bestScore) {
          bestMatch = c;
          bestScore = score;
        }
      }
      if (bestMatch) {
        // Don't auto-merge on name alone — flag as possible duplicate
        console.log(`🔍 Possible duplicate: "${fullName}" similar to "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);
        // Create new customer but flag the possible match
        const { data: newCustomer, error } = await supabase
          .from('customers')
          .insert({
            name: fullName,
            email: email.toLowerCase(),
            phone: phone || null,
            ticket_count: 1,
            tags: [],
            possible_duplicate_of: bestMatch.id,
          })
          .select().single();
        if (error) throw error;
        return { customer: newCustomer, matchType: 'possible_duplicate', possibleMatch: bestMatch, isNew: true };
      }
    }
  }

  // 4. No match — create new customer
  const { data: newCustomer, error } = await supabase
    .from('customers')
    .insert({
      name: fullName,
      email: email.toLowerCase(),
      phone: phone || null,
      ticket_count: 1,
      tags: [],
    })
    .select().single();
  if (error) throw error;
  return { customer: newCustomer, matchType: 'new', isNew: true };
}

// ---- Find open ticket for reply threading ----
async function findOpenTicketForCustomer(customerId) {
  const { data } = await supabase
    .from('tickets')
    .select('*')
    .eq('customer_id', customerId)
    .in('status', ['open', 'pending'])
    .order('updated_at', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}


// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TIPSY AF CS Backend v3', timestamp: new Date().toISOString() });
});


// ---- POST /webhook/contact-form ----
// Now with fuzzy matching and reply threading
app.post('/webhook/contact-form', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, purpose, message, attachment_info, submitted_at } = req.body;
    if (!first_name || !email || !message) {
      return res.status(400).json({ error: 'Missing required fields: first_name, email, message' });
    }

    const fullName = `${first_name} ${last_name || ''}`.trim();
    const autoTags = generateAutoTags(purpose || 'Other', message);
    const priority = determinePriority(purpose || 'Other', message);

    // Smart customer matching
    const { customer, matchType, possibleMatch, isNew } = await findOrCreateCustomer(email, phone, fullName);
    const customerId = customer.id;

    // Reply threading: check for open ticket from this customer
    const openTicket = await findOpenTicketForCustomer(customerId);

    let ticketId, ticket;

    if (openTicket) {
      // Thread onto existing open ticket
      ticketId = openTicket.ticket_id;

      // Add the new message to existing ticket
      await supabase.from('messages').insert({
        ticket_id: openTicket.id,
        sender_type: 'customer',
        sender_name: fullName,
        content: message,
        metadata: { purpose, phone, attachment: attachment_info || null, submitted_at: submitted_at || new Date().toISOString(), threaded: true }
      });

      // Merge new tags with existing
      const existingTags = openTicket.ai_tags || [];
      const mergedTags = [...new Set([...existingTags, ...autoTags])];

      // Update ticket
      await supabase.from('tickets').update({
        ai_tags: mergedTags,
        status: 'open', // Reopen if it was pending
        updated_at: new Date().toISOString(),
      }).eq('id', openTicket.id);

      ticket = openTicket;
      console.log(`🔄 Threaded reply onto ${ticketId} from ${fullName}`);

    } else {
      // Check if there's a recently closed ticket (within 24h) — reopen it
      const { data: recentClosed } = await supabase
        .from('tickets')
        .select('*')
        .eq('customer_id', customerId)
        .in('status', ['resolved', 'closed'])
        .order('updated_at', { ascending: false })
        .limit(1);

      const recentTicket = recentClosed && recentClosed.length > 0 ? recentClosed[0] : null;
      const wasRecentlyClosed = recentTicket && (Date.now() - new Date(recentTicket.updated_at).getTime() < 24 * 60 * 60 * 1000);

      if (wasRecentlyClosed) {
        // Reopen recently closed ticket
        ticketId = recentTicket.ticket_id;

        await supabase.from('messages').insert({
          ticket_id: recentTicket.id,
          sender_type: 'customer',
          sender_name: fullName,
          content: message,
          metadata: { purpose, phone, attachment: attachment_info || null, submitted_at: submitted_at || new Date().toISOString(), reopened: true }
        });

        await supabase.from('messages').insert({
          ticket_id: recentTicket.id,
          sender_type: 'system',
          sender_name: 'System',
          content: `Ticket reopened — customer sent a follow-up message.`,
        });

        const existingTags = recentTicket.ai_tags || [];
        const mergedTags = [...new Set([...existingTags, ...autoTags])];

        await supabase.from('tickets').update({
          ai_tags: mergedTags,
          status: 'open',
          updated_at: new Date().toISOString(),
        }).eq('id', recentTicket.id);

        ticket = recentTicket;
        console.log(`🔓 Reopened ${ticketId} from ${fullName}`);

      } else {
        // Create brand new ticket
        ticketId = generateTicketId();
        const summary = generateSummary(purpose || 'Other', message, fullName);

        const { data: newTicket, error: ticketError } = await supabase
          .from('tickets')
          .insert({
            ticket_id: ticketId,
            customer_id: customerId,
            subject: `${purpose || 'General'}: ${message.substring(0, 60)}${message.length > 60 ? '...' : ''}`,
            status: 'open',
            priority: priority,
            channel: 'site_form',
            ai_tags: autoTags,
            ai_summary: summary,
            purpose: purpose || 'Other',
          })
          .select().single();

        if (ticketError) throw ticketError;
        ticket = newTicket;

        await supabase.from('messages').insert({
          ticket_id: ticket.id,
          sender_type: 'customer',
          sender_name: fullName,
          content: message,
          metadata: { purpose, phone, attachment: attachment_info || null, submitted_at: submitted_at || new Date().toISOString() }
        });

        await supabase.from('messages').insert({
          ticket_id: ticket.id,
          sender_type: 'agent',
          sender_name: 'Auto-reply',
          content: `Thanks for reaching out! We've received your message and a team member will get back to you shortly. Your ticket number is ${ticketId}.`,
        });

        console.log(`✅ New ticket: ${ticketId} from ${fullName} (${email}) — ${purpose} [match: ${matchType}]`);
      }
    }

    res.status(201).json({
      success: true,
      ticket_id: ticketId,
      action: openTicket ? 'threaded' : 'created',
      customer_match: matchType,
      possible_duplicate: possibleMatch ? { id: possibleMatch.id, name: possibleMatch.name, email: possibleMatch.email } : null,
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Failed to process submission', details: error.message });
  }
});


// ---- GET /api/tickets ----
app.get('/api/tickets', async (req, res) => {
  try {
    const { status, priority, search, limit = 50 } = req.query;

    let query = supabase
      .from('tickets')
      .select(`*, customer:customers(*), messages(*), notes(*)`)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);

    const { data: tickets, error } = await query;
    if (error) throw error;

    const formatted = tickets.map(t => ({
      id: t.ticket_id,
      dbId: t.id,
      customerId: t.customer_id,
      customer: {
        id: t.customer?.id,
        name: t.customer?.name || 'Unknown',
        email: t.customer?.email || '',
        phone: t.customer?.phone || null,
        orders: t.customer?.shopify_order_count || 0,
        ltv: t.customer?.shopify_ltv || 0,
        tags: t.customer?.tags || [],
        altEmails: t.customer?.alt_emails || [],
        possibleDuplicateOf: t.customer?.possible_duplicate_of || null,
        ticketCount: t.customer?.ticket_count || 1,
      },
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      channel: t.channel,
      aiTags: t.ai_tags || [],
      aiSummary: t.ai_summary || '',
      purpose: t.purpose,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      order: null,
      messages: (t.messages || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(m => ({
          id: m.id, from: m.sender_type, name: m.sender_name, text: m.content, time: m.created_at,
          metadata: m.metadata || {},
        })),
      notes: (t.notes || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(n => ({ id: n.id, author: n.author, text: n.content, time: n.created_at })),
    }));

    res.json({ tickets: formatted });
  } catch (error) {
    console.error('❌ Error fetching tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets', details: error.message });
  }
});


// ---- GET /api/tickets/:ticketId ----
app.get('/api/tickets/:ticketId', async (req, res) => {
  try {
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select(`*, customer:customers(*), messages(*), notes(*)`)
      .eq('ticket_id', req.params.ticketId)
      .single();
    if (error || !ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket', details: error.message });
  }
});


// ---- PATCH /api/tickets/:ticketId/status ----
app.patch('/api/tickets/:ticketId/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['open', 'pending', 'resolved', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { error } = await supabase.from('tickets').update({ status, updated_at: new Date().toISOString() }).eq('ticket_id', req.params.ticketId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status', details: error.message });
  }
});


// ---- POST /api/tickets/:ticketId/reply ----
app.post('/api/tickets/:ticketId/reply', async (req, res) => {
  try {
    const { content, sender_name = 'Lauren' } = req.body;
    if (!content) return res.status(400).json({ error: 'Reply content is required' });
    const { data: ticket } = await supabase.from('tickets').select('id').eq('ticket_id', req.params.ticketId).single();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const { error } = await supabase.from('messages').insert({ ticket_id: ticket.id, sender_type: 'agent', sender_name, content });
    if (error) throw error;
    await supabase.from('tickets').update({ updated_at: new Date().toISOString() }).eq('id', ticket.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send reply', details: error.message });
  }
});


// ---- POST /api/tickets/:ticketId/notes ----
app.post('/api/tickets/:ticketId/notes', async (req, res) => {
  try {
    const { content, author = 'Josh' } = req.body;
    const { data: ticket } = await supabase.from('tickets').select('id, customer_id').eq('ticket_id', req.params.ticketId).single();
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { data: note, error } = await supabase.from('notes').insert({ ticket_id: ticket.id, author, content }).select().single();
    if (error) throw error;

    const newTags = generateTagsFromNote(content);
    if (newTags.length > 0 && ticket.customer_id) {
      const { data: customer } = await supabase.from('customers').select('tags').eq('id', ticket.customer_id).single();
      if (customer) {
        const merged = [...new Set([...(customer.tags || []), ...newTags])];
        await supabase.from('customers').update({ tags: merged, updated_at: new Date().toISOString() }).eq('id', ticket.customer_id);
        console.log(`🏷 Smart tags: ${newTags.join(', ')}`);
      }
    }

    res.json({ success: true, note, newCustomerTags: newTags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add note', details: error.message });
  }
});


// ============================================================
// CUSTOMER HISTORY
// ============================================================

// ---- GET /api/customers/:customerId/tickets ----
// Returns all tickets for a customer (full history)
app.get('/api/customers/:customerId/tickets', async (req, res) => {
  try {
    const { data: tickets, error } = await supabase
      .from('tickets')
      .select(`*, messages(id, sender_type, content, created_at), notes(id, content, author, created_at)`)
      .eq('customer_id', req.params.customerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formatted = tickets.map(t => ({
      id: t.ticket_id,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      channel: t.channel,
      purpose: t.purpose,
      aiTags: t.ai_tags || [],
      aiSummary: t.ai_summary || '',
      messageCount: (t.messages || []).length,
      noteCount: (t.notes || []).length,
      lastMessage: t.messages && t.messages.length > 0
        ? t.messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].content.substring(0, 100)
        : '',
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));

    res.json({ tickets: formatted, count: formatted.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer history', details: error.message });
  }
});


// ---- GET /api/customers/:customerId ----
// Get customer profile with duplicate info
app.get('/api/customers/:customerId', async (req, res) => {
  try {
    const { data: customer, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', req.params.customerId)
      .single();

    if (error || !customer) return res.status(404).json({ error: 'Customer not found' });

    // If this customer has a possible_duplicate_of, fetch that customer too
    let possibleDuplicate = null;
    if (customer.possible_duplicate_of) {
      const { data: dup } = await supabase
        .from('customers')
        .select('id, name, email, phone, ticket_count, tags')
        .eq('id', customer.possible_duplicate_of)
        .single();
      possibleDuplicate = dup;
    }

    // Also check if anyone else is a possible duplicate of THIS customer
    const { data: duplicatesOfMe } = await supabase
      .from('customers')
      .select('id, name, email, phone, ticket_count')
      .eq('possible_duplicate_of', req.params.customerId);

    res.json({
      customer,
      possibleDuplicate,
      duplicatesOfMe: duplicatesOfMe || [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customer', details: error.message });
  }
});


// ============================================================
// CUSTOMER MERGE
// ============================================================

// ---- POST /api/customers/merge ----
// Merge two customer records: keep primary, move all tickets/data from secondary
app.post('/api/customers/merge', async (req, res) => {
  try {
    const { primary_id, secondary_id } = req.body;
    if (!primary_id || !secondary_id) return res.status(400).json({ error: 'primary_id and secondary_id required' });
    if (primary_id === secondary_id) return res.status(400).json({ error: 'Cannot merge customer with themselves' });

    // Fetch both customers
    const { data: primary } = await supabase.from('customers').select('*').eq('id', primary_id).single();
    const { data: secondary } = await supabase.from('customers').select('*').eq('id', secondary_id).single();

    if (!primary || !secondary) return res.status(404).json({ error: 'One or both customers not found' });

    // 1. Move all tickets from secondary to primary
    const { error: ticketErr } = await supabase
      .from('tickets')
      .update({ customer_id: primary_id })
      .eq('customer_id', secondary_id);
    if (ticketErr) throw ticketErr;

    // 2. Merge tags
    const mergedTags = [...new Set([...(primary.tags || []), ...(secondary.tags || [])])];

    // 3. Merge alt_emails
    const allEmails = new Set([
      ...(primary.alt_emails || []),
      ...(secondary.alt_emails || []),
      secondary.email, // Add secondary's primary email as an alt
    ]);
    allEmails.delete(primary.email); // Don't include primary's own email
    const mergedAltEmails = [...allEmails];

    // 4. Take the best data from each (prefer non-null values)
    const updates = {
      phone: primary.phone || secondary.phone,
      tags: mergedTags,
      alt_emails: mergedAltEmails,
      ticket_count: (primary.ticket_count || 0) + (secondary.ticket_count || 0),
      shopify_customer_id: primary.shopify_customer_id || secondary.shopify_customer_id,
      shopify_order_count: Math.max(primary.shopify_order_count || 0, secondary.shopify_order_count || 0),
      shopify_ltv: Math.max(primary.shopify_ltv || 0, secondary.shopify_ltv || 0),
      possible_duplicate_of: null, // Clear any duplicate flags
      updated_at: new Date().toISOString(),
    };

    await supabase.from('customers').update(updates).eq('id', primary_id);

    // 5. Clear any duplicate references pointing to secondary
    await supabase
      .from('customers')
      .update({ possible_duplicate_of: null })
      .eq('possible_duplicate_of', secondary_id);

    // 6. Delete secondary customer
    await supabase.from('customers').delete().eq('id', secondary_id);

    console.log(`🔀 Merged customer: "${secondary.name}" (${secondary.email}) → "${primary.name}" (${primary.email})`);

    res.json({
      success: true,
      message: `Merged "${secondary.name}" into "${primary.name}"`,
      primary: { id: primary_id, name: primary.name, email: primary.email },
      secondary: { id: secondary_id, name: secondary.name, email: secondary.email },
      ticketsMoved: secondary.ticket_count || 0,
    });
  } catch (error) {
    console.error('❌ Merge error:', error);
    res.status(500).json({ error: 'Failed to merge customers', details: error.message });
  }
});


// ============================================================
// AI DRAFT
// ============================================================

app.post('/api/tickets/:ticketId/draft', async (req, res) => {
  try {
    const { context = '' } = req.body;
    const { data: ticket, error: ticketErr } = await supabase
      .from('tickets')
      .select(`*, customer:customers(*), messages(*), notes(*)`)
      .eq('ticket_id', req.params.ticketId)
      .single();
    if (ticketErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Also load customer's other tickets for context
    const { data: otherTickets } = await supabase
      .from('tickets')
      .select('ticket_id, subject, status, ai_tags, ai_summary, created_at')
      .eq('customer_id', ticket.customer_id)
      .neq('ticket_id', req.params.ticketId)
      .order('created_at', { ascending: false })
      .limit(5);

    const kb = await loadKnowledgeBase();
    const msgs = (ticket.messages || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => `[${m.sender_type === 'customer' ? 'CUSTOMER' : m.sender_type === 'system' ? 'SYSTEM' : 'AGENT'} - ${m.sender_name}]: ${m.content}`)
      .join('\n\n');

    const noteCtx = (ticket.notes || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(n => `[NOTE by ${n.author}]: ${n.content}`)
      .join('\n');

    const customerTags = (ticket.customer?.tags || []).join(', ');
    const historyCtx = otherTickets && otherTickets.length > 0
      ? otherTickets.map(t => `- ${t.ticket_id}: ${t.subject} [${t.status}] Tags: ${(t.ai_tags||[]).join(', ')}`).join('\n')
      : 'No previous tickets';

    const customerInfo = `Name: ${ticket.customer?.name || 'Unknown'}
Email: ${ticket.customer?.email || ''}
Phone: ${ticket.customer?.phone || 'Not provided'}
Orders: ${ticket.customer?.shopify_order_count || 0}
Lifetime Value: $${ticket.customer?.shopify_ltv || 0}
Customer Tags: ${customerTags || 'None'}
Ticket Count: ${ticket.customer?.ticket_count || 1}
Previous Tickets:\n${historyCtx}`;

    const systemPrompt = `You are a customer support agent for TIPSY AF, a zero-proof functional beverage company. You are drafting a reply to a customer support ticket.

# YOUR KNOWLEDGE BASE
${kb}

# RULES
- Write ONLY the reply text. No subject line, no "Dear customer", no meta-commentary.
- Follow the brand voice rules exactly.
- Sign off with just "Lauren" on its own line.
- Never use dashes or em-dashes. Use periods or commas instead.
- If the customer has tags like "Previous refund" or "Effect skeptic", factor that into your response.
- Be helpful, warm, and solution-oriented.
- Keep it concise. 3-5 short paragraphs max.
- Lead with the answer or solution.
- If there are previous tickets, reference relevant context naturally (don't say "I see in our records").`;

    let userPrompt = `# TICKET DETAILS
Ticket ID: ${ticket.ticket_id}
Subject: ${ticket.subject}
Purpose: ${ticket.purpose || 'General'}
Priority: ${ticket.priority}

# CUSTOMER INFO
${customerInfo}

# CONVERSATION
${msgs}

${noteCtx ? `# INTERNAL NOTES\n${noteCtx}\n` : ''}`;

    if (context.trim()) userPrompt += `\n# AGENT GUIDANCE\n${context}\n`;
    userPrompt += `\nDraft a reply to the customer's most recent message.`;

    const draft = await callClaude(systemPrompt, userPrompt);
    res.json({ success: true, draft });
  } catch (error) {
    console.error('❌ Draft error:', error);
    res.status(500).json({ error: 'Failed to generate draft', details: error.message });
  }
});


// ============================================================
// KNOWLEDGE BASE
// ============================================================

app.get('/api/kb', async (req, res) => {
  try {
    const { category } = req.query;
    let query = supabase.from('knowledge_base').select('*').order('priority', { ascending: false }).order('created_at', { ascending: true });
    if (category) query = query.eq('category', category);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch KB', details: error.message });
  }
});

app.post('/api/kb', async (req, res) => {
  try {
    const { category, title, content, priority = 5 } = req.body;
    if (!category || !title || !content) return res.status(400).json({ error: 'category, title, and content required' });
    const { data, error } = await supabase.from('knowledge_base').insert({ category, title, content, priority }).select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add KB item', details: error.message });
  }
});

app.put('/api/kb/:id', async (req, res) => {
  try {
    const { title, content, category, priority, is_active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (category !== undefined) updates.category = category;
    if (priority !== undefined) updates.priority = priority;
    if (is_active !== undefined) updates.is_active = is_active;
    const { data, error } = await supabase.from('knowledge_base').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update KB item', details: error.message });
  }
});

app.delete('/api/kb/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete KB item', details: error.message });
  }
});


// ============================================================
// TRANSCRIPT CLEANUP (AI-enhanced speech-to-text)
// ============================================================

app.post('/api/tickets/cleanup-transcript', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const cleaned = await callClaude(
      'You clean up speech-to-text transcriptions. Fix grammar, spelling, punctuation, and capitalization. Remove filler words (um, uh, like). Keep the meaning and tone identical. Return ONLY the cleaned text, nothing else.',
      text,
      512
    );

    res.json({ success: true, cleaned });
  } catch (error) {
    // If AI cleanup fails, return original text
    res.json({ success: true, cleaned: req.body.text });
  }
});


app.listen(PORT, () => {
  console.log(`🍄 TIPSY AF CS Backend v3.1 running on port ${PORT}`);
});
