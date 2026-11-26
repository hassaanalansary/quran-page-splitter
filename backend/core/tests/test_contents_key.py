"""The contents key: one grammar for what a blob holds, parsed, written and filled."""

from unittest import TestCase

from core.text.contents import (
    NOTHING_DECIDED,
    ContentsKey,
    ContentsKeyError,
    compound,
    count_key_paws,
    describe_contents_parts,
    fill_open_parts,
    find_letters_of_key,
    find_role_of_key,
    format_contents_key,
    is_key_complete,
    parse_contents_key,
    read_parts_into_key,
)


class ParseAndFormatTests(TestCase):
    def test_every_example_of_the_grammar_round_trips(self):
        for text in ("سو:", ":fatha", "ا:roundZero", "أ:", "إ+لا:", "ت:ijamDot", "?:*", ":?", "أ:?", "?+?:"):
            with self.subTest(text=text):
                self.assertEqual(format_contents_key(parse_contents_key(text)), text)

    def test_nothing_decided_is_the_empty_key(self):
        self.assertEqual(parse_contents_key(""), NOTHING_DECIDED)
        self.assertEqual(format_contents_key(NOTHING_DECIDED), "")
        self.assertEqual(parse_contents_key("*:*"), NOTHING_DECIDED)

    def test_marks_are_written_in_one_order(self):
        self.assertEqual(format_contents_key(parse_contents_key("إ:kasra+hamza")), "إ:hamza+kasra")
        self.assertEqual(compound("kasra", "hamza"), "hamza+kasra")

    def test_open_marks_go_last(self):
        self.assertEqual(format_contents_key(parse_contents_key("ا:?+roundZero")), "ا:roundZero+?")

    def test_parts_are_groups_of_elements(self):
        key = parse_contents_key("إ+لا:hamza")
        self.assertEqual(key, ContentsKey(("إ", "لا"), ("hamza",)))
        self.assertEqual(parse_contents_key("?:*"), ContentsKey((None,), None))

    def test_what_the_grammar_does_not_allow_is_refused(self):
        for text in ("سو", "a:b:c", "سو+:", "لا ل:", "عَ:", "دب:", ":fat-ha", "*+ب:", "ب:+fatha"):
            with self.subTest(text=text), self.assertRaises(ContentsKeyError):
                parse_contents_key(text)


class PartsTests(TestCase):
    def test_parts_carry_open_elements_and_undecided_groups_as_null(self):
        self.assertEqual(describe_contents_parts(parse_contents_key("ب+?:*")), {"paws": ["ب", None], "marks": None})
        alef = describe_contents_parts(parse_contents_key("ا:roundZero"))
        self.assertEqual(alef, {"paws": ["ا"], "marks": ["roundZero"]})

    def test_parts_read_back_into_the_same_key(self):
        for text in ("سو:", ":fatha", "?:*", "إ+لا:", "أ:?"):
            with self.subTest(text=text):
                key = parse_contents_key(text)
                self.assertEqual(read_parts_into_key(describe_contents_parts(key)), key)

    def test_no_parts_is_nothing_decided(self):
        self.assertEqual(read_parts_into_key(None), NOTHING_DECIDED)

    def test_bad_parts_are_refused(self):
        for parts in ({"paws": "ب"}, {"paws": [1]}, {"paws": ["دب"]}, {"marks": ["no way"]}, {"other": []}, []):
            with self.subTest(parts=parts), self.assertRaises(ContentsKeyError):
                read_parts_into_key(parts)


class FillTests(TestCase):
    def fill(self, decided: str, reading: str) -> str:
        return format_contents_key(fill_open_parts(parse_contents_key(decided), parse_contents_key(reading)))

    def test_an_undecided_group_takes_the_reading(self):
        self.assertEqual(self.fill("أ:*", "أ:hamza"), "أ:hamza")
        self.assertEqual(self.fill("", "سو:"), "سو:")

    def test_what_a_person_decided_is_never_replaced(self):
        self.assertEqual(self.fill("أ:", "أ:hamza"), "أ:")
        self.assertEqual(self.fill(":kasra", ":fatha"), ":kasra")

    def test_open_elements_fill_only_where_the_counts_agree(self):
        self.assertEqual(self.fill("?+?:", "إ+لا:"), "إ+لا:")
        self.assertEqual(self.fill("?+?:", "لا:"), "?+?:")
        self.assertEqual(self.fill("ا:?", "ا:roundZero"), "ا:roundZero")

    def test_a_lone_open_body_takes_however_many_the_reading_found(self):
        self.assertEqual(self.fill("?:*", "إ+لا:"), "إ+لا:")
        # A body, says the person; a mark, says the reading: the person's word stands.
        self.assertEqual(self.fill("?:*", ":fatha"), "?:fatha")


class QuestionsTests(TestCase):
    def test_the_paws_a_key_counts_for(self):
        self.assertEqual(count_key_paws(parse_contents_key("إ+لا:")), 2)
        self.assertEqual(count_key_paws(parse_contents_key(":fatha")), 0)
        self.assertIsNone(count_key_paws(parse_contents_key("?:*")))
        self.assertIsNone(count_key_paws(NOTHING_DECIDED))
        self.assertEqual(count_key_paws(parse_contents_key("?+?:")), 2)

    def test_the_role_a_key_says(self):
        self.assertEqual(find_role_of_key(parse_contents_key("ا:roundZero")), "body")
        self.assertEqual(find_role_of_key(parse_contents_key(":fatha")), "mark")
        self.assertEqual(find_role_of_key(parse_contents_key("?:*")), "body")
        self.assertEqual(find_role_of_key(parse_contents_key(":?")), "mark")
        self.assertIsNone(find_role_of_key(NOTHING_DECIDED))
        self.assertIsNone(find_role_of_key(parse_contents_key("*:fatha")))

    def test_complete_keys_have_nothing_open(self):
        self.assertTrue(is_key_complete(parse_contents_key("سو:")))
        self.assertFalse(is_key_complete(parse_contents_key("أ:*")))
        self.assertFalse(is_key_complete(parse_contents_key("ب+?:")))

    def test_the_letters_of_a_key(self):
        self.assertEqual(find_letters_of_key(parse_contents_key("إ+لا:hamza")), "إلا")
        self.assertEqual(find_letters_of_key(parse_contents_key("ب+?:")), "ب")
