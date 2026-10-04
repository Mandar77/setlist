/**
 * The paste-to-parsed-list screen (M1-07).
 *
 * Deliberately thin. Every rule this screen has to honour — grounding, the span contract,
 * what to say when nothing parses, treating the paste as data — lives in `parse.ts` as a
 * pure function and is tested there. What is left here is layout and two pieces of state,
 * which is the amount of logic an emulator run should have to cover.
 *
 * ## No network, and no way to make one
 *
 * M1-07 says the screen runs "entirely on device — no network call of any kind, provable
 * by running it in airplane mode". That property is structural here: this file imports
 * `parse.ts` and React Native, and nothing in either reaches a network. There is no fetch,
 * no client, and no API URL read on this path — `apiUrlFrom` is config the app carries for
 * later screens and this one never looks at it.
 *
 * ## testIDs are part of the contract
 *
 * Maestro drives this on the CI emulator, so the ids below are load-bearing rather than
 * decoration. Renaming one breaks the flow in `.maestro/`, which is the intended coupling:
 * the flow is an assertion about this screen and should fail when the screen changes.
 */

import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native'

import { parseForDisplay, type DisplayItem } from './parse'

function Item({ item, index }: { item: DisplayItem; index: number }): React.JSX.Element {
  return (
    <View style={styles.item} testID={`item-${index}`}>
      <Text style={styles.title} testID={`item-${index}-title`}>
        {item.title}
      </Text>
      <Text style={styles.artist} testID={`item-${index}-artist`}>
        {item.artist ?? 'unknown artist'}
      </Text>

      <View style={styles.meta}>
        <Text style={styles.confidence} testID={`item-${index}-confidence`}>
          {item.confidenceLabel}
        </Text>
        {item.qualifiers.map(qualifier => (
          <Text key={qualifier} style={styles.qualifier}>
            {qualifier}
          </Text>
        ))}
      </View>

      {item.alternate === null ? null : (
        <Text style={styles.alternate} testID={`item-${index}-alternate`}>
          or {item.alternate.title} — {item.alternate.artist ?? 'unknown artist'}
        </Text>
      )}

      {/*
        The source line, always shown rather than hidden behind a tap.
        "Reachable from each item" is the requirement; reachable without an interaction
        is the stronger version, and it is what makes a wrong parse obvious at a glance
        instead of something a user has to go looking for.
      */}
      <Text style={styles.source} testID={`item-${index}-source`}>
        {item.sourceLine}
      </Text>
    </View>
  )
}

export default function App(): React.JSX.Element {
  const [text, setText] = useState('')
  const scheme = useColorScheme()
  const dark = scheme === 'dark'

  // Parsing is pure and fast enough to run on every keystroke; memoized so a re-render
  // caused by anything else does not redo it.
  const view = useMemo(() => parseForDisplay(text), [text])

  return (
    <View style={[styles.screen, dark ? styles.screenDark : styles.screenLight]}>
      <Text style={[styles.heading, dark ? styles.textDark : styles.textLight]}>Setlist</Text>

      <TextInput
        testID="paste-input"
        style={[styles.input, dark ? styles.inputDark : styles.inputLight]}
        multiline
        autoCorrect={false}
        autoCapitalize="none"
        placeholder="Paste a song list"
        placeholderTextColor={dark ? '#7b7f8a' : '#9aa0ab'}
        value={text}
        onChangeText={setText}
      />

      <Text style={styles.count} testID="item-count">
        {view.items.length === 1 ? '1 song' : `${view.items.length} songs`}
      </Text>

      {view.notice === null ? null : (
        <Text style={styles.notice} testID="notice">
          {view.notice}
        </Text>
      )}

      <ScrollView style={styles.list} testID="song-list" keyboardShouldPersistTaps="handled">
        {view.items.map((item, index) => (
          <Item key={item.key} item={item} index={index} />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16, paddingTop: 48 },
  screenLight: { backgroundColor: '#fbfbfa' },
  screenDark: { backgroundColor: '#101114' },
  textLight: { color: '#15161a' },
  textDark: { color: '#f2f2f2' },
  heading: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  input: {
    minHeight: 110,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    textAlignVertical: 'top',
  },
  inputLight: { borderColor: '#d4d6db', color: '#15161a', backgroundColor: '#ffffff' },
  inputDark: { borderColor: '#2a2c33', color: '#f2f2f2', backgroundColor: '#17181c' },
  count: { marginTop: 12, fontSize: 13, color: '#7b7f8a' },
  notice: { marginTop: 8, fontSize: 15, color: '#8a6d1f', lineHeight: 21 },
  list: { marginTop: 8 },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2a2c3322' },
  title: { fontSize: 17, fontWeight: '600', color: '#2f6fd0' },
  artist: { fontSize: 15, color: '#6b7280', marginTop: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  confidence: { fontSize: 12, color: '#7b7f8a', marginRight: 8 },
  qualifier: { fontSize: 12, color: '#2f6fd0', marginRight: 8 },
  alternate: { fontSize: 13, color: '#8a6d1f', marginTop: 4 },
  source: { fontSize: 12, color: '#9aa0ab', marginTop: 6, fontStyle: 'italic' },
})
