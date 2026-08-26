import unittest
from unittest.mock import patch, MagicMock
import json
from app import app  # Changed from relative import to absolute import
from models import AdoptionStatus

# filepath: app/server/test_app.py
class TestApp(unittest.TestCase):
    def setUp(self):
        # Create a test client using Flask's test client
        self.app = app.test_client()
        self.app.testing = True
        # Turn off database initialization for tests
        app.config['TESTING'] = True
        
    def _create_mock_dog(self, dog_id, name, breed):
        """Helper method to create a mock dog with standard attributes"""
        dog = MagicMock(spec=['to_dict', 'id', 'name', 'breed'])
        dog.id = dog_id
        dog.name = name
        dog.breed = breed
        dog.to_dict.return_value = {'id': dog_id, 'name': name, 'breed': breed}
        return dog
        
    def _setup_query_mock(self, mock_query, dogs):
        """Helper method to configure the query mock"""
        mock_query_instance = MagicMock()
        mock_query.return_value = mock_query_instance
        mock_query_instance.join.return_value = mock_query_instance
        mock_query_instance.filter.return_value = mock_query_instance
        mock_query_instance.count.return_value = len(dogs)
        mock_query_instance.offset.return_value = mock_query_instance
        mock_query_instance.limit.return_value = mock_query_instance
        mock_query_instance.all.return_value = dogs
        return mock_query_instance

    @patch('app.db.session.query')
    def test_get_dogs_success(self, mock_query):
        """Test successful retrieval of multiple dogs"""
        # Arrange
        dog1 = self._create_mock_dog(1, "Buddy", "Labrador")
        dog2 = self._create_mock_dog(2, "Max", "German Shepherd")
        mock_dogs = [dog1, dog2]
        
        self._setup_query_mock(mock_query, mock_dogs)
        
        # Act
        response = self.app.get('/api/dogs')
        
        # Assert
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.data)
        self.assertEqual(len(data['dogs']), 2)
        self.assertEqual(data['page'], 1)
        self.assertEqual(data['total'], 2)
        
        # Verify first dog
        self.assertEqual(data['dogs'][0]['id'], 1)
        self.assertEqual(data['dogs'][0]['name'], "Buddy")
        self.assertEqual(data['dogs'][0]['breed'], "Labrador")
        
        # Verify second dog
        self.assertEqual(data['dogs'][1]['id'], 2)
        self.assertEqual(data['dogs'][1]['name'], "Max")
        self.assertEqual(data['dogs'][1]['breed'], "German Shepherd")
        
        # Verify query was called
        mock_query.assert_called_once()
        
    @patch('app.db.session.query')
    def test_get_dogs_empty(self, mock_query):
        """Test retrieval when no dogs are available"""
        # Arrange
        self._setup_query_mock(mock_query, [])
        
        # Act
        response = self.app.get('/api/dogs')
        
        # Assert
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertEqual(data['dogs'], [])
        self.assertEqual(data['total'], 0)
        
    @patch('app.db.session.query')
    def test_get_dogs_structure(self, mock_query):
        """Test the response structure for a single dog"""
        # Arrange
        dog = self._create_mock_dog(1, "Buddy", "Labrador")
        self._setup_query_mock(mock_query, [dog])
        
        # Act
        response = self.app.get('/api/dogs')
        
        # Assert
        data = json.loads(response.data)
        self.assertIn('dogs', data)
        self.assertIn('page', data)
        self.assertIn('total', data)
        self.assertIn('total_pages', data)
        self.assertTrue(isinstance(data['dogs'], list))
        self.assertEqual(len(data['dogs']), 1)
        self.assertEqual(set(data['dogs'][0].keys()), {'id', 'name', 'breed'})


class TestGetDogsFiltering(unittest.TestCase):
    """Covers the optional `status` and `breed` query parameters."""

    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True
        app.config['TESTING'] = True

    def _setup_query_mock(self, mock_query, dogs, total=None):
        """Query mock whose count() can differ from the page it returns.

        `total` defaults to len(dogs); passing it explicitly models a filtered
        set larger than one page.
        """
        mock_query_instance = MagicMock()
        mock_query.return_value = mock_query_instance
        mock_query_instance.join.return_value = mock_query_instance
        mock_query_instance.filter.return_value = mock_query_instance
        mock_query_instance.count.return_value = len(dogs) if total is None else total
        mock_query_instance.offset.return_value = mock_query_instance
        mock_query_instance.limit.return_value = mock_query_instance
        mock_query_instance.all.return_value = dogs
        return mock_query_instance

    def _dog(self, dog_id, name, breed):
        dog = MagicMock(spec=['id', 'name', 'breed'])
        dog.id = dog_id
        dog.name = name
        dog.breed = breed
        return dog

    @patch('app.db.session.query')
    def test_filter_by_status_applies_a_filter(self, mock_query):
        """A status value narrows the query and returns 200."""
        q = self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])

        response = self.app.get('/api/dogs?status=AVAILABLE')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(q.filter.call_count, 1)
        data = json.loads(response.data)
        self.assertEqual(len(data['dogs']), 1)

    @patch('app.db.session.query')
    def test_status_is_case_insensitive(self, mock_query):
        """available, Available and AVAILABLE behave identically."""
        for value in ('available', 'Available', 'AVAILABLE'):
            with self.subTest(value=value):
                self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])
                response = self.app.get(f'/api/dogs?status={value}')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(json.loads(response.data)['dogs']), 1)

    @patch('app.db.session.query')
    def test_every_adoption_status_is_accepted(self, mock_query):
        """All three members of AdoptionStatus are valid input."""
        for member in AdoptionStatus:
            with self.subTest(status=member.name):
                self._setup_query_mock(mock_query, [])
                response = self.app.get(f'/api/dogs?status={member.name}')
                self.assertEqual(response.status_code, 200)

    @patch('app.db.session.query')
    def test_unknown_status_is_a_400(self, mock_query):
        """An unrecognised status is rejected, not ignored and not a 500."""
        self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])

        response = self.app.get('/api/dogs?status=BANANA')

        self.assertEqual(response.status_code, 400)
        data = json.loads(response.data)
        self.assertIn('error', data)
        self.assertIn('BANANA', data['error'])
        self.assertNotIn('dogs', data)

    @patch('app.db.session.query')
    def test_filter_by_breed_applies_a_filter(self, mock_query):
        """A breed value narrows the query and returns 200."""
        q = self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])

        response = self.app.get('/api/dogs?breed=Labrador')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(q.filter.call_count, 1)

    @patch('app.db.session.query')
    def test_breed_is_case_insensitive(self, mock_query):
        """Breed matching does not depend on the casing sent by the client."""
        for value in ('labrador', 'Labrador', 'LABRADOR'):
            with self.subTest(value=value):
                self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])
                response = self.app.get(f'/api/dogs?breed={value}')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(json.loads(response.data)['dogs']), 1)

    @patch('app.db.session.query')
    def test_status_and_breed_combine(self, mock_query):
        """Both parameters together apply both filters, not just one."""
        q = self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])

        response = self.app.get('/api/dogs?status=AVAILABLE&breed=Labrador')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(q.filter.call_count, 2)

    @staticmethod
    def _call_order(query_mock):
        """Names of the query methods, in the order they were called."""
        return [name for name, _, _ in query_mock.mock_calls if name]

    @patch('app.db.session.query')
    def test_total_describes_the_filtered_set(self, mock_query):
        """total and total_pages come from the filtered query, not the table.

        Asserting on the value alone cannot catch a count taken too early: the
        mock returns the same object from filter(), so a premature count()
        yields the same number. The order of the calls is what distinguishes
        them, so that is what is asserted.
        """
        q = self._setup_query_mock(
            mock_query, [self._dog(i, f"Dog {i}", "Labrador") for i in range(1, 7)], total=13
        )

        response = self.app.get('/api/dogs?status=AVAILABLE&per_page=6')

        data = json.loads(response.data)
        self.assertEqual(data['total'], 13)
        self.assertEqual(data['total_pages'], 3)

        order = self._call_order(q)
        self.assertIn('count', order)
        self.assertIn('filter', order)
        self.assertLess(
            order.index('filter'), order.index('count'),
            f"count() ran before filter(), so total describes the unfiltered table: {order}"
        )

    @patch('app.db.session.query')
    def test_both_filters_precede_the_count(self, mock_query):
        """With both parameters, neither filter may land after the count."""
        q = self._setup_query_mock(mock_query, [], total=0)

        self.app.get('/api/dogs?status=AVAILABLE&breed=Labrador')

        order = self._call_order(q)
        last_filter = len(order) - 1 - order[::-1].index('filter')
        self.assertLess(
            last_filter, order.index('count'),
            f"a filter was applied after count(): {order}"
        )

    @patch('app.db.session.query')
    def test_no_parameters_leaves_the_query_unfiltered(self, mock_query):
        """Without parameters the endpoint behaves exactly as it did before."""
        q = self._setup_query_mock(mock_query, [self._dog(1, "Buddy", "Labrador")])

        response = self.app.get('/api/dogs')

        self.assertEqual(response.status_code, 200)
        q.filter.assert_not_called()
        data = json.loads(response.data)
        self.assertEqual(set(data.keys()), {'dogs', 'page', 'per_page', 'total', 'total_pages'})
        self.assertEqual(set(data['dogs'][0].keys()), {'id', 'name', 'breed'})
        self.assertEqual(data['page'], 1)
        self.assertEqual(data['per_page'], 6)


if __name__ == '__main__':
    unittest.main()