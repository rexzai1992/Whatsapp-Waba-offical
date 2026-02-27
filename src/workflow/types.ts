export type WorkflowAction =
    | {
          type: 'send_text'
          text: string
          template?: { name: string; language?: string; components?: any[] }
      }
    | {
          type: 'send_buttons'
          text: string
          buttons: Array<{ id: string; title: string }>
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
    | { type: 'set_tag'; tag: string }
    | { type: 'update_state'; state: string }
    | { type: 'end_flow' }

export type WorkflowState = {
    workflow_id: string
    step_index: number
    state?: string
    awaiting_buttons?: string[]
    awaiting_routes?: Record<string, number | { next_step?: number; state?: string }>
    fallback_count?: number
}
