// ============================================================
// TIPSY AF — Customer Service Backend Server
// Handles: Contact form webhooks, ticket management, API
// Deploy to: Render.com (free tier)
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

// ---- Helper: Generate Ticket ID ----
function generateTicketId() {
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `TIX-${num}`;
}

// ---- Helper: Auto-tag based on purpose and message content ----
function generateAutoTags(purpose, message) {
  const tags = [];
  const msg = message.toLowerCase();

  // Purpose-based tags
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
  if (purposeTags[purpose]) {
    tags.push(...purposeTags[purpose]);
  }

  // Content-based tags
  if (msg.includes('cancel') || msg.includes('subscription')) tags.push('Subscription issue');
  if (msg.includes('refund') || msg.includes('money back')) tags.push('Refund request');
  if (msg.includes('tracking') || msg.includes('where is my order')) tags.push('Tracking question');
  if (msg.includes('flavor') || msg.includes('taste')) tags.push('Flavor feedback');
  if (msg.includes('bulk') || msg.includes('event') || msg.includes('wholesale')) tags.push('Bulk opportunity');
  if (msg.includes('love') || msg.includes('amazing') || msg.includes('obsessed')) tags.push('Positive sentiment');
  if (msg.includes('disappoint') || msg.includes('not working') || msg.includes('doesn\'t work')) tags.push('At risk');
  if (msg.includes('gift')) tags.push('Gift buyer');
  if (msg.includes('how long') || msg.includes('dosage') || msg.includes('how much')) tags.push('Dosage question');
  if (msg.includes('new flavor') || msg.includes('mango') || msg.includes('lemon')) tags.push('New flavor interest');

  // Deduplicate
  return [...new Set(tags)];
}

// ---- Helper: Generate AI summary (placeholder — will use Claude API later) ----
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


// ============================================================
// ROUTES
// ============================================================

// ---- Health Check ----
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TIPSY AF CS Backend', timestamp: new Date().toISOString() });
});


// ---- POST /webhook/contact-form ----
// Receives submissions from the Shopify contact form
app.post('/webhook/contact-form', async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      purpose,
      message,
      attachment_info,
      submitted_at
    } = req.body;

    // Validate required fields
    if (!first_name || !email || !message) {
      return res.status(400).json({ error: 'Missing required fields: first_name, email, message' });
    }

    const fullName = `${first_name} ${last_name || ''}`.trim();
    const ticketId = generateTicketId();
    const autoTags = generateAutoTags(purpose || 'Other', message);
    const priority = determinePriority(purpose || 'Other', message);
    const summary = generateSummary(purpose || 'Other', message, fullName);

    // Check if customer already exists (by email)
    const { data: existingCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    let customerId;

    if (existingCustomer) {
      // Update existing customer
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
      // Create new customer
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

    // Create the ticket
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

    // Create the first message
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

    // Create auto-reply message
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
// Returns all tickets for the dashboard
app.get('/api/tickets', async (req, res) => {
  try {
    const { status, priority, search, limit = 50 } = req.query;

    let query = supabase
      .from('tickets')
      .select(`
        *,
        customer:customers(*),
        messages(*)
      `)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);

    const { data: tickets, error } = await query;

    if (error) throw error;

    // Transform into dashboard-friendly format
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
      order: null, // Will be populated when Shopify is connected
      messages: (t.messages || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(m => ({
          id: m.id,
          from: m.sender_type,
          name: m.sender_name,
          text: m.content,
          time: m.created_at,
        })),
      notes: [], // Will come from notes table
    }));

    res.json({ tickets: formatted });

  } catch (error) {
    console.error('❌ Error fetching tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets', details: error.message });
  }
});


// ---- GET /api/tickets/:ticketId ----
// Returns a single ticket with full details
app.get('/api/tickets/:ticketId', async (req, res) => {
  try {
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select(`*, customer:customers(*), messages(*)`)
      .eq('ticket_id', req.params.ticketId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ ticket });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket', details: error.message });
  }
});


// ---- PATCH /api/tickets/:ticketId/status ----
// Update ticket status
app.patch('/api/tickets/:ticketId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['open', 'pending', 'resolved', 'closed'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

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
// Send a reply on a ticket
app.post('/api/tickets/:ticketId/reply', async (req, res) => {
  try {
    const { content, sender_name = 'Josh' } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Reply content is required' });
    }

    // Get ticket DB id
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

    // Update ticket timestamp
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
// Add internal note
app.post('/api/tickets/:ticketId/notes', async (req, res) => {
  try {
    const { content, author = 'Josh' } = req.body;

    const { data: ticket } = await supabase
      .from('tickets')
      .select('id')
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
    res.json({ success: true, note });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add note', details: error.message });
  }
});


// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`🍄 TIPSY AF CS Backend running on port ${PORT}`);
});
