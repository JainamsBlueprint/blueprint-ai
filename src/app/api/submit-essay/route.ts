// src/app/api/submit-essay/route.ts
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const { essay, prompt } = await request.json();

    // Validate input
    if (!essay || !prompt) {
      return NextResponse.json(
        { error: 'Essay and prompt are required' },
        { status: 400 }
      );
    }

    if (essay.length < 50) {
      return NextResponse.json(
        { error: 'Essay must be at least 50 characters long' },
        { status: 400 }
      );
    }

    // ~8000 chars ≈ 1500-2000 words, well above the stated 1000-word limit
    if (essay.length > 8000) {
      return NextResponse.json(
        { error: 'Essay exceeds maximum length of 8000 characters.' },
        { status: 400 }
      );
    }

    if (prompt.length > 2000) {
      return NextResponse.json(
        { error: 'Prompt exceeds maximum length of 2000 characters.' },
        { status: 400 }
      );
    }

    // Create an authenticated Supabase server client using cookies
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name) {
            return cookieStore.get(name)?.value;
          },
          set(name, value, options) {
            cookieStore.set({ name, value, ...options });
          },
          remove(name, options) {
            cookieStore.delete({ name, ...options });
          },
        },
      }
    );

    // Derive the current user from the session instead of trusting a client-provided userId
    const { data: { user } } = await supabase.auth.getUser();

    // Require authentication to submit essays
    if (!user) {
      return NextResponse.json(
        { error: 'Please create a free account to get essay feedback. Sign up for 3 free reviews!' },
        { status: 401 }
      );
    }

    type DbUser = {
      id: string;
      email: string | null;
      essays_used_this_month: number;
      subscription_status: 'free' | 'premium';
    };
    let userRecord: DbUser | null = null;
    let essaysUsed = 0;

    // Ensure user record exists
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userError && userError.code !== 'PGRST116') {
      console.error('Error fetching user record:', userError);
    }

    if (!userData) {
      const { data: newUser, error: insertUserError } = await supabase
        .from('users')
        .insert([
          {
            id: user.id,
            email: user.email!,
            essays_used_this_month: 0,
            subscription_status: 'free',
          },
        ])
        .select()
        .single();

      if (insertUserError) {
        console.error('Error creating user record:', insertUserError);
      } else if (newUser) {
        userRecord = newUser;
      }
    } else {
      userRecord = userData;
    }

    // Atomically check the limit and increment the counter in one DB operation.
    // This prevents the race condition where concurrent requests all read the same
    // count before any of them write, bypassing the 3-essay limit.
    const { data: creditResult, error: creditError } = await supabase
      .rpc('use_essay_credit', { p_user_id: user.id });

    if (creditError) {
      console.error('Error checking essay credit:', creditError);
      return NextResponse.json({ error: 'Failed to verify usage limit.' }, { status: 500 });
    }

    if (!creditResult?.allowed) {
      return NextResponse.json(
        { error: 'Free plan limit reached. Please upgrade to premium for unlimited essays.' },
        { status: 403 }
      );
    }

    essaysUsed = creditResult.count;

    // Create the feedback prompt
    const feedbackPrompt = `You are an expert college admissions counselor and essay reviewer. Please provide detailed, constructive feedback on this college essay.

ESSAY PROMPT: ${prompt}

STUDENT'S ESSAY: ${essay}

Please provide feedback in the following structured format:

**OVERALL IMPRESSION** (2-3 sentences)
Brief summary of the essay's strengths and main areas for improvement.

**CONTENT & STORYTELLING** (3-4 bullet points)
- [Specific feedback about the story, experiences shared, and personal insights]
- [Comments on how well the essay answers the prompt]
- [Suggestions for stronger narrative elements]

**STRUCTURE & FLOW** (2-3 bullet points)  
- [Feedback on essay organization and transitions]
- [Comments on introduction and conclusion effectiveness]

**WRITING STYLE** (2-3 bullet points)
- [Feedback on voice, tone, and word choice] 
- [Suggestions for clearer or more engaging language]

**SPECIFIC SUGGESTIONS** (3-5 actionable items)
1. [Concrete suggestion for improvement]
2. [Another specific recommendation]
3. [Additional actionable advice]

**STRENGTH TO HIGHLIGHT**
[One key strength to emphasize and build upon]

**FINAL THOUGHTS**
[Encouraging closing remarks with next steps]

Keep feedback constructive, specific, and encouraging. Focus on helping the student improve while maintaining their authentic voice.`;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert college admissions counselor providing helpful, constructive essay feedback to high school students.',
        },
        {
          role: 'user',
          content: feedbackPrompt,
        },
      ],
      max_tokens: 800,
      temperature: 0.7,
    });

    const feedback = completion.choices[0]?.message?.content;

    if (!feedback) {
      throw new Error('No feedback generated');
    }

    const wordCount = essay.trim().split(/\s+/).length;

    // If user is authenticated, save to database and update usage
    if (user && userRecord) {
      try {
        // Save essay to database
        const { error: insertError } = await supabase
          .from('essays')
          .insert([
            {
              user_id: user.id,
              essay_text: essay,
              essay_prompt: prompt,
              ai_feedback: feedback,
              word_count: wordCount,
              title: `Essay ${new Date().toLocaleDateString()}`
            }
          ]);
        if (insertError) {
          console.error('Database save error (essays insert):', insertError);
        }

        // Count was already atomically incremented by use_essay_credit RPC above
      } catch (dbError) {
        console.error('Database save error:', dbError);
      }
    }

    // Calculate remaining essays (essaysUsed is already the post-increment count from the RPC)
    let essaysRemaining;
    if (userRecord) {
      if (userRecord.subscription_status === 'premium') {
        essaysRemaining = 'unlimited';
      } else {
        essaysRemaining = Math.max(0, 3 - essaysUsed);
      }
    } else {
      essaysRemaining = 'anonymous';
    }

    // Return the feedback
    return NextResponse.json({
      feedback,
      wordCount,
      timestamp: new Date().toISOString(),
      userAuthenticated: !!user && !!userRecord,
      essaysRemaining
    });

  } catch (error) {
    console.error('Error generating essay feedback:', error);
    
    return NextResponse.json(
      { error: 'Failed to generate feedback. Please try again.' },
      { status: 500 }
    );
  }
}