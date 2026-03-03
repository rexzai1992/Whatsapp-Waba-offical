export type WorkflowAction =
    | {
          type: 'send_text'
          text: string
          media?: {
              type: 'image' | 'video' | 'document'
              link: string
              filename?: string
          }
          template?: { name: string; language?: string; components?: any[] }
      }
    | {
          type: 'send_buttons'
          text: string
          buttons: Array<{ id: string; title: string }>
          header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; link: string }
          footer?: string
          template?: { name: string; language?: string; components?: any[] }
          routes?: Record<string, number | { next_step?: number; state?: string }>
          fallback_text?: string
      }
    | {
          type: 'send_list'
          text: string
          button_text: string
          sections: Array<{
              title?: string
              rows: Array<{ id: string; title: string; description?: string }>
          }>
          header?: { type: 'text'; text: string }
          footer?: string
          template?: { name: string; language?: string; components?: any[] }
          routes?: Record<string, number | { next_step?: number; state?: string }>
          fallback_text?: string
      }
    | {
          type: 'send_cta_url'
          body: string
          button_text: string
          url: string
          header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; link: string }
          footer?: string
          template?: { name: string; language?: string; components?: any[] }
      }
    | {
          type: 'send_image'
          link: string
          caption?: string
          template?: { name: string; language?: string; components?: any[] }
      }
    | {
          type: 'send_document'
          link: string
          filename: string
          caption?: string
          template?: { name: string; language?: string; components?: any[] }
      }
    | {
          type: 'send_template'
          name: string
          language?: string
          components?: any[]
      }
    | {
          type: 'ask_question'
          question: string
          save_as: string
          fallback_text?: string
          retry_limit?: number
      }
    | {
          type: 'condition'
          source: string
          operator?:
              | 'equals'
              | 'not_equals'
              | 'contains'
              | 'starts_with'
              | 'exists'
              | 'greater_than'
              | 'less_than'
          value?: string | number | null
          true_step?: number
          false_step?: number
      }
    | {
          type: 'add_tags'
          tags: string[]
      }
    | {
          type: 'assign_staff'
          assignee_user_id?: string | null
          assignee_name?: string | null
          assignee_color?: string | null
      }
    | {
          type: 'trigger_workflow'
          workflow_id: string
      }
    | { type: 'set_tag'; tag: string }
    | { type: 'update_state'; state: string }
    | { type: 'end_flow' }

export type WorkflowState = {
    workflow_id: string
    step_index: number
    state?: string
    vars?: Record<string, string>
    qa_history?: Array<{
        key: string
        question: string
        answer: string
        at: string
    }>
    awaiting_buttons?: string[]
    awaiting_routes?: Record<string, number | { next_step?: number; state?: string }>
    awaiting_input?: {
        save_as: string
        question?: string
        fallback_text?: string
        retry_limit?: number
    }
    fallback_count?: number
}
