<template>
  <button
    role="switch"
    :aria-checked="modelValue"
    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full
           border-2 border-transparent transition-colors duration-150 ease-in-out
           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
           focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    :class="modelValue ? 'bg-primary' : 'bg-muted'"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm
             ring-0 transition-transform duration-150 ease-in-out"
      :class="modelValue ? 'translate-x-5' : 'translate-x-0'"
    />
  </button>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, required: true },
})

defineEmits(['update:modelValue'])
</script>
