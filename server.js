// ============================================================
// TIPSY AF — Customer Service Backend Server v2
// Handles: Contact form webhooks, ticket management, API,
//          Knowledge Base, AI drafting (Claude), smart tagging
// Deploy to: Render.com
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---- Supabase Client ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---- Claude API Config ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// ---- Helper: Generate Ticket ID ----
function generateTicketId() {
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `TIX-${num}`;
}

// ---- Helper: Auto-tag based on purpose and message content ----
function generateAutoTags(purpose, message) {
  const tags = [];
  const msg = message.toLowerCase();

  const purposeTags = {
    'Billing': ['Billing inquiry'],
    'Tech Support': ['Technical issue'],
    'Product Questions': ['Product inquiry'],
    'Shipping & Delivery': ['Shipping issue'],
    'Returns & Refunds': ['Refund request'],
    'Wholesale': ['Wholesale inquiry', 'Bulk order'],
    'Partnership': ['Partnership inquiry'],
    'Press & Media': ['Press inquiry'],
    'Other': ['General inquiry'],
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

// ---- Helper: Generate AI summary ----
function generateSummary(purpose, message, name) {
  return `${name} submitted a ${purpose.toLowerCase()} inquiry via the contact form.`;
}

// ---- Helper: Determine priority ----
function determinePriority(purpose, message) {
  const msg = message.toLowerCase();
  if (msg.includes('urgent') || msg.includes('asap') || msg.includes('immediately')) return 'urgent';
  if (purpose === 'Returns & Refunds' || msg.includes('refund') || msg.includes('cancel')) return 'high';
  if (purpose === 'Billing' || purpose === 'Shipping & Delivery') return 'high';
  if (purpose === 'Wholesale' || purpose === 'Partnership') return 'medium';
  return 'medium';
}

// ---- Helper: Call Claude API ----
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ---- Helper: Load Knowledge Base for AI context ----
async function loadKnowledgeBase() {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('category, title, content')
    .eq('is_active', true)
    .order('priority', { ascending: false });

  if (error) {
    console.error('Failed to load KB:', error);
    return '';
  }

  const sections = {};
  for (const item of data) {
    if (!sections[item.category]) sections[item.category] = [];
    sections[item.category].push(`### ${item.title}\n${item.content}`);
  }

  const categoryLabels = {
    brand_voice: 'BRAND VOICE & TONE',
    product: 'PRODUCT KNOWLEDGE',
    policy: 'POLICIES & PROCEDURES',
    launch: 'UPCOMING LAUNCHES & PROMOS',
    example_response: 'EXAMPLE RESPONSES',
  };

  let kb = '';
  for (const [cat, items] of Object.entries(sections)) {
    kb += `\n## ${categoryLabels[cat] || cat.toUpperCase()}\n\n${items.join('\n\n')}\n`;
  }
  return kb;
}

// ---- Helper: Generate customer tags from note content ----
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


// ============================================================
// ROUTES
// ============================================================

// ---- Health Check ----
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TIPSY AF CS Backend v2', timestamp: new Date().toISOString() });
});


// ---- POST /webhook/contact-form ----
app.post('/webhook/contact-form', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, purpose, message, attachment_info, submitted_at } = req.body;

    if (!first_name || !email || !message) {
      return res.status(400).json({ error: 'Missing required fields: first_name, email, message' });
    }

    const fullName = `${first_name} ${last_name || ''}`.trim();
    const ticketId = generateTicketId();
    const autoTags = generateAutoTags(purpose || 'Other', message);
    const priority = determinePriority(purpose || 'Other', message);
    const summary = generateSummary(purpose || 'Other', message, fullName);

    const { data: existingCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    let customerId;

    if (existingCustomer) {
      customerId = existingCustomer.id;
      await supabase
        .from('customers')
        .update({
          name: fullName,
          phone: phone || existingCustomer.phone,
          ticket_count: existingCustomer.ticket_count + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', customerId);
    } else {
      const { data: newCustomer, error: custError } = await supabase
        .from('customers')
        .insert({
          name: fullName,
          email: email.toLowerCase(),
          phone: phone || null,
          ticket_count: 1,
          tags: [],
        })
        .select()
        .single();

      if (custError) throw custError;
      customerId = newCustomer.id;
    }

    const { data: ticket, error: ticketError } = await supabase
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
      .select()
      .single();

    if (ticketError) throw ticketError;

    const { error: msgError } = await supabase
      .from('messages')
      .insert({
        ticket_id: ticket.id,
        sender_type: 'customer',
        sender_name: fullName,
        content: message,
        metadata: {
          purpose: purpose,
          phone: phone,
          attachment: attachment_info || null,
          submitted_at: submitted_at || new Date().toISOString(),
        }
      });

    if (msgError) throw msgError;

    await supabase
      .from('messages')
      .insert({
        ticket_id: ticket.id,
        sender_type: 'agent',
        sender_name: 'Auto-reply',
        content: `Thanks for reaching out! We've received your message and a team member will get back to you shortly. Your ticket number is ${ticketId}.`,
      });

    console.log(`✅ Ticket created: ${ticketId} from ${fullName} (${email}) — ${purpose}`);

    res.status(201).json({
      success: true,
      ticket_id: ticketId,
      message: 'Ticket created successfully',
    });

  } catch (error) {
    console.error('❌ Error creating ticket:', error);
    res.status(500).json({ error: 'Failed to create ticket', details: error.message });
  }
});


// ---- GET /api/tickets ----
app.get('/api/tickets', async (req, res) => {
  try {
    const { status, priority, search, limit = 50 } = req.query;

    let query = supabase
      .from('tickets')
      .select(`
        *,
        customer:customers(*),
        messages(*),
        notes(*)
      `)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);

    const { data: tickets, error } = await query;

    if (error) throw error;

    const formatted = tickets.map(t => ({
      id: t.ticket_id,
      dbId: t.id,
      customer: {
        name: t.customer?.name || 'Unknown',
        email: t.customer?.email || '',
        phone: t.customer?.phone || null,
        orders: t.customer?.shopify_order_count || 0,
        ltv: t.customer?.shopify_ltv || 0,
        tags: t.customer?.tags || [],
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
          id: m.id,
          from: m.sender_type,
          name: m.sender_name,
          text: m.content,
          time: m.created_at,
        })),
      notes: (t.notes || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(n => ({
          id: n.id,
          author: n.author,
          text: n.content,
          time: n.created_at,
        })),
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
    const validStatuses = ['open', 'pending', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { error } = await supabase
      .from('tickets')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('ticket_id', req.params.ticketId);

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

    const { data: ticket } = await supabase
      .from('tickets')
      .select('id')
      .eq('ticket_id', req.params.ticketId)
      .single();

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { error } = await supabase
      .from('messages')
      .insert({
        ticket_id: ticket.id,
        sender_type: 'agent',
        sender_name: sender_name,
        content: content,
      });

    if (error) throw error;

    await supabase
      .from('tickets')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', ticket.id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send reply', details: error.message });
  }
});


// ---- POST /api/tickets/:ticketId/notes ----
app.post('/api/tickets/:ticketId/notes', async (req, res) => {
  try {
    const { content, author = 'Josh' } = req.body;

    const { data: ticket } = await supabase
      .from('tickets')
      .select('id, customer_id')
      .eq('ticket_id', req.params.ticketId)
      .single();

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { data: note, error } = await supabase
      .from('notes')
      .insert({
        ticket_id: ticket.id,
        author: author,
        content: content,
      })
      .select()
      .single();

    if (error) throw error;

    // Generate smart tags from note content
    const newTags = generateTagsFromNote(content);

    if (newTags.length > 0 && ticket.customer_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('tags')
        .eq('id', ticket.customer_id)
        .single();

      if (customer) {
        const existingTags = customer.tags || [];
        const mergedTags = [...new Set([...existingTags, ...newTags])];

        await supabase
          .from('customers')
          .update({ tags: mergedTags, updated_at: new Date().toISOString() })
          .eq('id', ticket.customer_id);

        console.log(`🏷 Smart tags added to customer: ${newTags.join(', ')}`);
      }
    }

    res.json({ success: true, note, newCustomerTags: newTags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add note', details: error.message });
  }
});


// ============================================================
// AI DRAFT ENDPOINT
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

    const kb = await loadKnowledgeBase();

    const msgs = (ticket.messages || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => `[${m.sender_type === 'customer' ? 'CUSTOMER' : 'AGENT'} - ${m.sender_name}]: ${m.content}`)
      .join('\n\n');

    const noteCtx = (ticket.notes || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(n => `[NOTE by ${n.author}]: ${n.content}`)
      .join('\n');

    const customerTags = (ticket.customer?.tags || []).join(', ');
    const customerInfo = `Name: ${ticket.customer?.name || 'Unknown'}
Email: ${ticket.customer?.email || ''}
Phone: ${ticket.customer?.phone || 'Not provided'}
Orders: ${ticket.customer?.shopify_order_count || 0}
Lifetime Value: $${ticket.customer?.shopify_ltv || 0}
Customer Tags: ${customerTags || 'None'}
Ticket Count: ${ticket.customer?.ticket_count || 1}`;

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
- Lead with the answer or solution.`;

    let userPrompt = `# TICKET DETAILS
Ticket ID: ${ticket.ticket_id}
Subject: ${ticket.subject}
Purpose: ${ticket.purpose || 'General'}
Priority: ${ticket.priority}
Status: ${ticket.status}
AI Tags: ${(ticket.ai_tags || []).join(', ')}

# CUSTOMER INFO
${customerInfo}

# CONVERSATION HISTORY
${msgs}

${noteCtx ? `# INTERNAL NOTES (not visible to customer)\n${noteCtx}\n` : ''}`;

    if (context.trim()) {
      userPrompt += `\n# AGENT GUIDANCE (follow these instructions for this specific reply)\n${context}\n`;
    }

    userPrompt += `\nPlease draft a reply to the customer's most recent message. Follow all brand voice rules and knowledge base policies.`;

    const draft = await callClaude(systemPrompt, userPrompt);

    res.json({ success: true, draft });

  } catch (error) {
    console.error('❌ Error generating draft:', error);
    res.status(500).json({ error: 'Failed to generate draft', details: error.message });
  }
});


// ============================================================
// KNOWLEDGE BASE ENDPOINTS
// ============================================================

app.get('/api/kb', async (req, res) => {
  try {
    const { category } = req.query;
    let query = supabase
      .from('knowledge_base')
      .select('*')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

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
    if (!category || !title || !content) {
      return res.status(400).json({ error: 'category, title, and content are required' });
    }

    const { data, error } = await supabase
      .from('knowledge_base')
      .insert({ category, title, content, priority })
      .select()
      .single();

    if (error) throw error;
    console.log(`📚 KB item added: [${category}] ${title}`);
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

    const { data, error } = await supabase
      .from('knowledge_base')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update KB item', details: error.message });
  }
});

app.delete('/api/kb/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete KB item', details: error.message });
  }
});


// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`🍄 TIPSY AF CS Backend v2 running on port ${PORT}`);
});
