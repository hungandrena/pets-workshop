import os
from typing import Dict, List, Any, Optional
from flask import Flask, jsonify, request, Response
from sqlalchemy import func
from models import init_db, db, Dog, Breed, AdoptionStatus

# Get the server directory path
base_dir: str = os.path.abspath(os.path.dirname(__file__))

app: Flask = Flask(__name__)
db_path: str = os.environ.get('DATABASE_PATH', os.path.join(base_dir, 'dogshelter.db'))
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize the database with the app
init_db(app)

def _parse_status(raw: str) -> AdoptionStatus:
    """Resolve a status query value, case-insensitively, to an AdoptionStatus.

    Raises ValueError when the value names no member, so the caller can answer
    400 rather than letting the lookup surface as a 500.
    """
    try:
        return AdoptionStatus[raw.strip().upper()]
    except KeyError:
        raise ValueError(raw)


@app.route('/api/dogs', methods=['GET'])
def get_dogs() -> tuple[Response, int] | Response:
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 6, type=int)
    page = max(1, page)
    per_page = max(1, min(per_page, 100))

    status_arg: Optional[str] = request.args.get('status')
    breed_arg: Optional[str] = request.args.get('breed')

    query = db.session.query(
        Dog.id, 
        Dog.name, 
        Breed.name.label('breed')
    ).join(Breed, Dog.breed_id == Breed.id)

    if status_arg is not None:
        try:
            status = _parse_status(status_arg)
        except ValueError:
            accepted = ', '.join(member.name for member in AdoptionStatus)
            return jsonify({
                'error': f"Unknown status '{status_arg}'. Accepted values are: {accepted}."
            }), 400
        query = query.filter(Dog.status == status)

    # TODO(pipeline) revisit whether breed should match on id as well
    if breed_arg is not None:
        query = query.filter(func.lower(Breed.name) == breed_arg.strip().lower())

    # Counted after the filters are applied, so total and total_pages describe
    # the filtered set and paging through a filtered list terminates.
    total = query.count()
    dogs_query = query.offset((page - 1) * per_page).limit(per_page).all()
    
    dogs_list: List[Dict[str, Any]] = [
        {
            'id': dog.id,
            'name': dog.name,
            'breed': dog.breed
        }
        for dog in dogs_query
    ]
    
    return jsonify({
        'dogs': dogs_list,
        'page': page,
        'per_page': per_page,
        'total': total,
        'total_pages': max(1, -(-total // per_page))
    })

@app.route('/api/dogs/<int:id>', methods=['GET'])
def get_dog(id: int) -> tuple[Response, int] | Response:
    # Query the specific dog by ID and join with breed to get breed name
    dog_query = db.session.query(
        Dog.id,
        Dog.name,
        Breed.name.label('breed'),
        Dog.age,
        Dog.description,
        Dog.gender,
        Dog.status
    ).join(Breed, Dog.breed_id == Breed.id).filter(Dog.id == id).first()
    
    # Return 404 if dog not found
    if not dog_query:
        return jsonify({"error": "Dog not found"}), 404
    
    # Convert the result to a dictionary
    dog: Dict[str, Any] = {
        'id': dog_query.id,
        'name': dog_query.name,
        'breed': dog_query.breed,
        'age': dog_query.age,
        'description': dog_query.description,
        'gender': dog_query.gender,
        'status': dog_query.status.name
    }
    
    return jsonify(dog)

## HERE

if __name__ == '__main__':
    app.run(debug=True, port=5100) # Port 5100 to avoid macOS conflicts
